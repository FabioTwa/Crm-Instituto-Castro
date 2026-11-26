-- 58 Importacao diaria do "Relatorio de agendamentos" do Support Clinic
--    (pedido do Fabio, 25 e 26/11/2026)
--
-- Um robo no GitHub (workflow "Support Clinic - exportacao diaria") entra uma vez
-- por dia no Support Clinic com o usuario do IC, exporta o relatorio de
-- agendamentos (mes atual + seguinte) e manda as linhas para a funcao
-- ic-supportclinic, que chama public.ic_sc_importar().
--
-- O que chega: codigo, telefone, data/hora, tipo, profissional, agendado por,
-- status e data de criacao. O NOME do paciente nao e enviado.
-- O que fica: SO as linhas cujo telefone e de um card do CRM. O resto e
-- descartado (LGPD); de tudo, so a contagem por status (sem dado pessoal).
-- Cada importacao APAGA a anterior do mesmo periodo e grava a nova.
--
-- Etapas (so cards ativos; nunca mexe em Fechado, Lead Antigo ou Perdido; so
-- considera agendamentos criados a partir do dia anterior a chegada do lead):
--   Atendido                                   -> Consulta Realizada (so para frente)
--   Agendado/Confirmado/Atrasado/Sala de espera/
--   Em atendimento, com data de hoje em diante -> Visita Confirmada (so para frente)
--   Ultimo agendamento Faltou/Cancelado/Desmarcado/Nao atendido, sem outro ativo,
--   card em Visita Confirmada                  -> volta para Agendamento Pendente,
--                                                 com anotacao no historico (uma vez
--                                                 por agendamento e status)
--   Reagendado: ignorado (o novo horario vem em outra linha).
--
-- Chaves em crm_ia_config:
--   sc_importacao_ligada  'true' | 'false'  (false: a funcao recebe e nao grava nada)
--   sc_alerta_whatsapp    numero que recebe o aviso de falha do robo
-- Idempotente.

-- Etapa "Consulta Realizada" no funil Atendimento Geral (criada em 25/11 a
-- pedido do Fabio; aqui so para o registro ficar no repositorio).
do $$
declare
  f uuid;
begin
  select id into f from public.crm_funis where nome = 'Atendimento Geral' limit 1;
  if f is not null and not exists (
    select 1 from public.crm_funil_etapas where funil_id = f and nome = 'consulta_realizada'
  ) then
    update public.crm_funil_etapas set ordem = ordem + 1
     where funil_id = f
       and ordem > (select ordem from public.crm_funil_etapas where funil_id = f and nome = 'visita_confirmada');
    insert into public.crm_funil_etapas (funil_id, nome, label, cor, ordem)
    select f, 'consulta_realizada', 'Consulta Realizada', '#2E9E6B', ordem + 1
      from public.crm_funil_etapas where funil_id = f and nome = 'visita_confirmada';
  end if;
end $$;

-- Agendamentos do Support Clinic de pacientes que sao cards do CRM.
create table if not exists public.ic_sc_agendamentos (
  codigo          text not null,
  cliente_crm_id  uuid not null references public.clientes_crm (id) on delete cascade,
  telefone_norm   text not null,
  inicio          timestamptz,
  fim             timestamptz,
  tipo            text,
  profissional    text,
  agendado_por    text,
  status          text not null,
  criado_sc       timestamptz,
  importado_em    timestamptz not null default now(),
  primary key (codigo, cliente_crm_id)
);
create index if not exists ic_sc_agendamentos_cliente_idx
  on public.ic_sc_agendamentos (cliente_crm_id, inicio desc);
create index if not exists ic_sc_agendamentos_inicio_idx
  on public.ic_sc_agendamentos (inicio);

-- O que a importacao ja fez por agendamento e status (evita anotacao repetida).
create table if not exists public.ic_sc_eventos (
  codigo          text not null,
  status          text not null,
  cliente_crm_id  uuid not null references public.clientes_crm (id) on delete cascade,
  acao            text not null,
  criado_em       timestamptz not null default now(),
  primary key (codigo, status, cliente_crm_id)
);

-- Uma linha por importacao (sem dado pessoal).
create table if not exists public.ic_sc_importacoes (
  id           uuid primary key default gen_random_uuid(),
  criado_em    timestamptz not null default now(),
  periodo_ini  date not null,
  periodo_fim  date not null,
  linhas       integer not null default 0,
  casados      integer not null default 0,
  movidos      integer not null default 0,
  voltaram     integer not null default 0,
  por_status   jsonb not null default '{}'::jsonb,
  origem       text
);

-- Dados de paciente: so o service role (funcoes) escreve; no CRM, so Admin le.
alter table public.ic_sc_agendamentos enable row level security;
alter table public.ic_sc_eventos enable row level security;
alter table public.ic_sc_importacoes enable row level security;
revoke all on public.ic_sc_agendamentos, public.ic_sc_eventos, public.ic_sc_importacoes from anon, authenticated;
grant select on public.ic_sc_agendamentos, public.ic_sc_eventos, public.ic_sc_importacoes to authenticated;
grant all on public.ic_sc_agendamentos, public.ic_sc_eventos, public.ic_sc_importacoes to service_role;
drop policy if exists ic_sc_agendamentos_admin_le on public.ic_sc_agendamentos;
create policy ic_sc_agendamentos_admin_le on public.ic_sc_agendamentos
  for select to authenticated using (public.ic_eh_admin());
drop policy if exists ic_sc_eventos_admin_le on public.ic_sc_eventos;
create policy ic_sc_eventos_admin_le on public.ic_sc_eventos
  for select to authenticated using (public.ic_eh_admin());
drop policy if exists ic_sc_importacoes_admin_le on public.ic_sc_importacoes;
create policy ic_sc_importacoes_admin_le on public.ic_sc_importacoes
  for select to authenticated using (public.ic_eh_admin());

-- Telefone do Support Clinic ("(11) 99575 - 1525") -> forma de clientes_crm.telefone_norm
-- (DDD + numero, sem 55; celular antigo de 8 digitos ganha o 9).
create or replace function public.ic_sc_telefone_norm(p text)
returns text
language sql
immutable
as $$
  with d as (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as dig),
  s as (
    select case when length(dig) in (12, 13) and left(dig, 2) = '55' then substr(dig, 3) else dig end as sem
    from d
  )
  select case
    when length(sem) = 10 and substr(sem, 3, 1) between '6' and '9'
      then substr(sem, 1, 2) || '9' || substr(sem, 3)
    when length(sem) in (10, 11) then sem
    else null
  end
  from s;
$$;

-- "25/11/2026 09:40 - 10:00" -> inicio e fim; "19/11/2026 - 09:57:36" -> instante.
-- Horario de Sao Paulo. Texto fora do formato -> null (a linha fica sem data).
create or replace function public.ic_sc_data_hora(p text, p_parte text)
returns timestamptz
language plpgsql
immutable
as $$
declare
  m text[];
begin
  if p is null then return null; end if;
  m := regexp_match(p, '^\s*(\d{2})/(\d{2})/(\d{4})\D+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s*-\s*(\d{2}):(\d{2}))?\s*$');
  if m is null then return null; end if;
  if p_parte = 'fim' then
    if m[7] is null then return null; end if;
    return make_timestamptz(m[3]::int, m[2]::int, m[1]::int, m[7]::int, m[8]::int, 0, 'America/Sao_Paulo');
  end if;
  return make_timestamptz(m[3]::int, m[2]::int, m[1]::int, m[4]::int, m[5]::int, coalesce(m[6], '0')::int, 'America/Sao_Paulo');
exception when others then
  return null;
end;
$$;

create or replace function public.ic_sc_importar(
  p_ini    date,
  p_fim    date,
  p_linhas jsonb,
  p_origem text default 'robo'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ativos   text[] := array['agendado', 'confirmado', 'atrasado', 'sala de espera', 'em atendimento'];
  v_falhas   text[] := array['faltou', 'cancelado', 'desmarcado', 'não atendido', 'nao atendido'];
  v_ligada   text;
  v_linhas   integer;
  v_casados  integer;
  v_movidos  integer := 0;
  v_voltaram integer := 0;
  v_status   jsonb;
  v_id       uuid;
  c          record;
  v_alvo     text;
  v_ag       record;
  v_ord_atual integer;
  v_ord_alvo  integer;
  v_desc      text;
begin
  if p_ini is null or p_fim is null or p_fim < p_ini or p_fim - p_ini > 100 then
    raise exception 'periodo_invalido';
  end if;
  if jsonb_typeof(p_linhas) is distinct from 'array' then
    raise exception 'linhas_invalidas';
  end if;

  select valor into v_ligada from public.crm_ia_config where chave = 'sc_importacao_ligada';
  if coalesce(v_ligada, 'false') <> 'true' then
    return jsonb_build_object('ok', true, 'ignorado', 'importacao_desligada');
  end if;

  create temp table _sc on commit drop as
  select
    left(trim(x.codigo), 40)                         as codigo,
    public.ic_sc_telefone_norm(x.telefone)           as telefone_norm,
    public.ic_sc_data_hora(x.data, 'inicio')         as inicio,
    public.ic_sc_data_hora(x.data, 'fim')            as fim,
    left(trim(x.tipo), 200)                          as tipo,
    left(trim(x.profissional), 120)                  as profissional,
    left(trim(x.agendado_por), 120)                  as agendado_por,
    left(trim(x.status), 40)                         as status,
    public.ic_sc_data_hora(x.criado, 'inicio')       as criado_sc
  from jsonb_to_recordset(p_linhas) as x(
    codigo text, telefone text, data text, tipo text, profissional text,
    agendado_por text, status text, criado text
  )
  where coalesce(trim(x.codigo), '') <> '' and coalesce(trim(x.status), '') <> '';

  select count(*) into v_linhas from _sc;
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into v_status
    from (select status, count(*) as n from _sc group by status) t;

  -- Apaga a importacao anterior do periodo e grava a nova (so quem e card do CRM).
  delete from public.ic_sc_agendamentos
   where (inicio at time zone 'America/Sao_Paulo')::date between p_ini and p_fim;

  insert into public.ic_sc_agendamentos
    (codigo, cliente_crm_id, telefone_norm, inicio, fim, tipo, profissional, agendado_por, status, criado_sc)
  select distinct on (s.codigo, cc.id)
    s.codigo, cc.id, s.telefone_norm, s.inicio, s.fim, s.tipo, s.profissional, s.agendado_por, s.status, s.criado_sc
  from _sc s
  join public.clientes_crm cc
    on cc.telefone_norm = s.telefone_norm
   and cc.deleted_at is null and cc.mesclado_para is null
  where s.telefone_norm is not null
  on conflict (codigo, cliente_crm_id) do update set
    telefone_norm = excluded.telefone_norm, inicio = excluded.inicio, fim = excluded.fim,
    tipo = excluded.tipo, profissional = excluded.profissional, agendado_por = excluded.agendado_por,
    status = excluded.status, criado_sc = excluded.criado_sc, importado_em = now();

  select count(distinct cliente_crm_id) into v_casados
    from public.ic_sc_agendamentos a
   where a.importado_em >= now() - interval '1 minute'
     and (a.inicio at time zone 'America/Sao_Paulo')::date between p_ini and p_fim;

  -- Decide a etapa de cada card que tem agendamento importado.
  for c in
    select cc.id, cc.etapa, cc.funil_id,
           (coalesce(cc.lead_chegou_em, cc.data_entrada::timestamptz, cc.created_at)
              at time zone 'America/Sao_Paulo')::date - 1 as desde
      from public.clientes_crm cc
     where cc.deleted_at is null and cc.mesclado_para is null
       and cc.etapa not in ('fechado', 'cliente_antigo', 'perdido')
       and exists (select 1 from public.ic_sc_agendamentos a where a.cliente_crm_id = cc.id)
  loop
    v_alvo := null;
    v_ag := null;

    -- 1) Atendido
    select a.* into v_ag from public.ic_sc_agendamentos a
     where a.cliente_crm_id = c.id and lower(a.status) = 'atendido'
       and (coalesce(a.criado_sc, a.inicio) at time zone 'America/Sao_Paulo')::date >= c.desde
     order by a.inicio desc nulls last limit 1;
    if found then
      v_alvo := 'consulta_realizada';
    else
      -- 2) Agendamento ativo de hoje em diante
      select a.* into v_ag from public.ic_sc_agendamentos a
       where a.cliente_crm_id = c.id and lower(a.status) = any (v_ativos)
         and (coalesce(a.criado_sc, a.inicio) at time zone 'America/Sao_Paulo')::date >= c.desde
         and a.inicio >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'
       order by a.inicio asc nulls last limit 1;
      if found then
        v_alvo := 'visita_confirmada';
      end if;
    end if;

    if v_alvo is not null then
      select ordem into v_ord_atual from public.crm_funil_etapas where funil_id = c.funil_id and nome = c.etapa;
      select ordem into v_ord_alvo from public.crm_funil_etapas where funil_id = c.funil_id and nome = v_alvo;
      -- So para frente, e so se o funil tem a etapa.
      if v_ord_alvo is not null and v_ord_atual is not null and v_ord_atual < v_ord_alvo then
        update public.clientes_crm set etapa = v_alvo, updated_at = now() where id = c.id;
        v_desc := 'Movido automaticamente: Support Clinic — '
          || coalesce(v_ag.tipo, 'consulta')
          || coalesce(' em ' || to_char(v_ag.inicio at time zone 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI'), '')
          || coalesce(' com ' || v_ag.profissional, '')
          || ' (' || v_ag.status || ')';
        insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo)
        values (c.id, c.etapa, v_alvo, 'Sistema', left(v_desc, 500), 'automatico');
        v_movidos := v_movidos + 1;
      end if;
      continue;
    end if;

    -- 3) Ultimo agendamento nao aconteceu e nao ha outro ativo: volta para
    --    Agendamento Pendente com anotacao (so se estava em Visita Confirmada).
    if c.etapa <> 'visita_confirmada' then
      continue;
    end if;
    select a.* into v_ag from public.ic_sc_agendamentos a
     where a.cliente_crm_id = c.id
       and lower(a.status) <> 'reagendado'
       and (coalesce(a.criado_sc, a.inicio) at time zone 'America/Sao_Paulo')::date >= c.desde
     order by coalesce(a.criado_sc, a.inicio) desc nulls last, a.inicio desc nulls last
     limit 1;
    if not found or not (lower(v_ag.status) = any (v_falhas)) then
      continue;
    end if;
    if exists (select 1 from public.ic_sc_eventos e
                where e.codigo = v_ag.codigo and e.status = v_ag.status and e.cliente_crm_id = c.id) then
      continue;
    end if;
    if not exists (select 1 from public.crm_funil_etapas where funil_id = c.funil_id and nome = 'agendamento_pendente') then
      continue;
    end if;

    update public.clientes_crm set etapa = 'agendamento_pendente', updated_at = now() where id = c.id;
    v_desc := 'Support Clinic: '
      || coalesce('consulta de ' || v_ag.tipo, 'consulta')
      || coalesce(' marcada para ' || to_char(v_ag.inicio at time zone 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI'), '')
      || coalesce(' com ' || v_ag.profissional, '')
      || case lower(v_ag.status)
           when 'faltou' then ': o paciente faltou'
           when 'cancelado' then ': foi cancelada'
           when 'desmarcado' then ': foi desmarcada'
           else ': não aconteceu (' || v_ag.status || ')'
         end
      || '. Card voltou para Agendamento Pendente: falta remarcar.';
    insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo)
    values (c.id, c.etapa, 'agendamento_pendente', 'Sistema', left(v_desc, 500), 'automatico');
    insert into public.ic_sc_eventos (codigo, status, cliente_crm_id, acao)
    values (v_ag.codigo, v_ag.status, c.id, 'voltou_agendamento_pendente')
    on conflict do nothing;
    v_voltaram := v_voltaram + 1;
  end loop;

  insert into public.ic_sc_importacoes (periodo_ini, periodo_fim, linhas, casados, movidos, voltaram, por_status, origem)
  values (p_ini, p_fim, v_linhas, coalesce(v_casados, 0), v_movidos, v_voltaram, v_status, left(coalesce(p_origem, 'robo'), 40))
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'importacao_id', v_id, 'linhas', v_linhas, 'casados', coalesce(v_casados, 0),
    'movidos', v_movidos, 'voltaram', v_voltaram
  );
end;
$$;

revoke all on function public.ic_sc_importar(date, date, jsonb, text) from public, anon, authenticated;
grant execute on function public.ic_sc_importar(date, date, jsonb, text) to service_role;

insert into public.crm_ia_config (chave, valor, descricao)
values
  ('sc_importacao_ligada', 'true',
   'Importacao diaria do relatorio do Support Clinic (SQL 58). false = a funcao recebe e nao grava nada.'),
  ('sc_alerta_whatsapp', '5511972663460',
   'Numero que recebe o aviso quando o robo do Support Clinic falha (SQL 58). Vazio = sem aviso.')
on conflict (chave) do nothing;

select chave, valor from public.crm_ia_config where chave in ('sc_importacao_ligada', 'sc_alerta_whatsapp');

-- DESLIGAR: update public.crm_ia_config set valor = 'false' where chave = 'sc_importacao_ligada';
-- ROLLBACK: drop function if exists public.ic_sc_importar(date, date, jsonb, text);
--           drop function if exists public.ic_sc_data_hora(text, text);
--           drop function if exists public.ic_sc_telefone_norm(text);
--           drop table if exists public.ic_sc_eventos, public.ic_sc_agendamentos, public.ic_sc_importacoes;
--           delete from public.crm_ia_config where chave in ('sc_importacao_ligada', 'sc_alerta_whatsapp');
--           (a etapa consulta_realizada fica: ja tem cards nela)
