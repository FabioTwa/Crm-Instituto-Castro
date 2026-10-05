-- 18 IC: agendamentos de consulta e credenciais do Google Agenda
-- IC CRM, camada sobre o esquema base (00-12). Depende de 13 (etapas
-- agendamento_pendente / consulta_agendada), 14, 15 e 17 (ia_handoffs).
--
-- O que faz:
--   1. agendamentos: um compromisso por card (consulta, retorno, avaliacao),
--      com status, responsavel e espelho no Google (google_event_id,
--      google_sync_status). A sincronizacao e feita pela Edge Function; o
--      banco so marca 'pendente'.
--   2. ic_google_credenciais: refresh token do Google de cada usuario,
--      CIFRADO pela Edge Function com chave em variavel de ambiente. Nenhum
--      select para authenticated; o usuario ve so google_email e ativo pela
--      RPC ic_minha_agenda_google().
--   3. Gatilhos: atualizado_em (before update) e trg_agendamento_confirmado
--      (after insert/update of status): quando vira 'confirmado' (a) abre um
--      ia_handoffs 'agendamento_confirmado' se nao houver pendente igual,
--      (b) se o funil do card tem etapa agendamento_pendente ou
--      consulta_agendada e o card esta em etapa ANTERIOR (menor ordem), move
--      o card para la e grava crm_historico tipo automatico. Nunca mexe em
--      card em fechado/perdido/cliente_antigo.
--   4. RPCs: ic_agendamentos_lista, ic_agendamento_criar,
--      ic_agendamento_status, ic_minha_agenda_google.
--   5. RLS: select no escopo do card (via clientes_crm), insert/update
--      logados, delete negado. Realtime: agendamentos entra na publicacao.
-- Idempotente.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------
create table if not exists public.agendamentos (
  id                  uuid primary key default gen_random_uuid(),
  cliente_crm_id      uuid not null references public.clientes_crm(id),
  funil_id            uuid,
  responsavel_id      text,
  responsavel_nome    text,
  titulo              text not null,
  inicio              timestamptz not null,
  fim                 timestamptz not null,
  status              text not null default 'pendente' check (status in ('pendente', 'confirmado', 'cancelado', 'realizado', 'faltou')),
  tipo                text default 'consulta',
  telefone_lead       text,
  observacoes         text,
  origem              text default 'manual' check (origem in ('manual', 'ia', 'lead')),
  google_event_id     text,
  google_calendar_id  text,
  google_sync_status  text default 'pendente' check (google_sync_status in ('pendente', 'sincronizado', 'erro', 'desligado')),
  google_sync_erro    text,
  criado_por          text,
  criado_em           timestamptz default now(),
  atualizado_em       timestamptz default now()
);
create index if not exists idx_agendamentos_inicio on public.agendamentos (inicio);
create index if not exists idx_agendamentos_cliente on public.agendamentos (cliente_crm_id);
create index if not exists idx_agendamentos_responsavel on public.agendamentos (responsavel_id, inicio);
create index if not exists idx_agendamentos_google_pendente on public.agendamentos (criado_em) where google_sync_status = 'pendente';
comment on table public.agendamentos is 'IC: consultas/retornos marcados para um card. google_* e o espelho no Google Agenda, sincronizado pela Edge Function quando a flag agendamento_google esta ligada.';

create table if not exists public.ic_google_credenciais (
  user_id                text primary key references public.users(id) on delete cascade,
  google_email           text,
  refresh_token_cifrado  text,
  calendar_id            text default 'primary',
  ativo                  boolean default true,
  atualizado_em          timestamptz default now()
);
comment on table public.ic_google_credenciais is 'IC: credencial Google Agenda por usuario. refresh_token_cifrado e cifrado pela Edge Function com chave em variavel de ambiente (nunca em claro, nunca no front). Sem select para authenticated: so service_role; o usuario ve google_email/ativo por ic_minha_agenda_google().';

-- ---------------------------------------------------------------------------
-- 2. Gatilhos
-- ---------------------------------------------------------------------------
create or replace function public.ic_agendamento_touch()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

drop trigger if exists trg_agendamento_touch on public.agendamentos;
create trigger trg_agendamento_touch before update on public.agendamentos
  for each row execute function public.ic_agendamento_touch();

create or replace function public.ic_agendamento_confirmado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c            public.clientes_crm;
  alvo_nome    text;
  alvo_ordem   integer;
  atual_ordem  integer;
begin
  if new.status <> 'confirmado' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmado' then
    return new;  -- ja estava confirmado: nada a fazer
  end if;

  select * into c from public.clientes_crm where id = new.cliente_crm_id;
  if c.id is null then
    return new;
  end if;

  -- (a) handoff para o humano, uma vez por agendamento pendente
  if not exists (
    select 1 from public.ia_handoffs h
    where h.cliente_crm_id = c.id and h.motivo = 'agendamento_confirmado' and h.atendido_em is null
  ) then
    insert into public.ia_handoffs (cliente_crm_id, motivo, detalhe)
    values (c.id, 'agendamento_confirmado',
            coalesce(new.titulo, 'Agendamento') || ' em ' || to_char(new.inicio at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'));
  end if;

  -- (b) move o card para a etapa de agendamento do funil, se estiver antes dela
  if c.etapa in ('fechado', 'perdido', 'cliente_antigo') or c.deleted_at is not null or c.mesclado_para is not null then
    return new;
  end if;

  select e.nome, e.ordem into alvo_nome, alvo_ordem
  from public.crm_funil_etapas e
  where e.funil_id = c.funil_id and e.nome in ('agendamento_pendente', 'consulta_agendada')
  order by e.ordem
  limit 1;

  if alvo_nome is null then
    return new;
  end if;

  select e.ordem into atual_ordem
  from public.crm_funil_etapas e
  where e.funil_id = c.funil_id and e.nome = c.etapa;

  if atual_ordem is not null and atual_ordem < alvo_ordem then
    update public.clientes_crm set etapa = alvo_nome, updated_at = now() where id = c.id;
    insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo)
    values (c.id, c.etapa, alvo_nome, 'Sistema',
            'Movido automaticamente: agendamento confirmado (' || coalesce(new.titulo, '') || ')', 'automatico');
  end if;

  return new;
end;
$$;
comment on function public.ic_agendamento_confirmado() is 'IC: ao confirmar um agendamento, abre handoff agendamento_confirmado e move o card para agendamento_pendente/consulta_agendada se ele estiver em etapa anterior. Nunca mexe em fechado/perdido/cliente_antigo.';

drop trigger if exists trg_agendamento_confirmado on public.agendamentos;
create trigger trg_agendamento_confirmado after insert or update of status on public.agendamentos
  for each row execute function public.ic_agendamento_confirmado();

-- ---------------------------------------------------------------------------
-- 3. RPCs
-- ---------------------------------------------------------------------------
create or replace function public.ic_agendamentos_lista(p_de date, p_ate date, p_responsavel text default null, p_status text default null)
returns table (
  id uuid, cliente_crm_id uuid, nome text, telefone text, etapa text, etapa_label text, funil_id uuid, funil_nome text,
  responsavel_id text, responsavel_nome text, titulo text, inicio timestamptz, fim timestamptz, status text, tipo text,
  observacoes text, origem text, google_sync_status text, criado_em timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select a.id, a.cliente_crm_id, c.nome, coalesce(a.telefone_lead, c.telefone), c.etapa,
         coalesce(e.label, e.nome, c.etapa), c.funil_id, f.nome,
         a.responsavel_id, a.responsavel_nome, a.titulo, a.inicio, a.fim, a.status, a.tipo,
         a.observacoes, a.origem, a.google_sync_status, a.criado_em
  from public.agendamentos a
  join public.clientes_crm c on c.id = a.cliente_crm_id
  left join public.crm_funis f on f.id = c.funil_id
  left join public.crm_funil_etapas e on e.funil_id = c.funil_id and e.nome = c.etapa
  where a.inicio >= p_de::timestamptz
    and a.inicio < (p_ate + 1)::timestamptz
    and (p_responsavel is null or a.responsavel_id = p_responsavel)
    and (p_status is null or a.status = p_status)
  order by a.inicio;
$$;
comment on function public.ic_agendamentos_lista(date, date, text, text) is 'IC: agendamentos do periodo com nome, telefone, etapa e funil do card. Invoker: a RLS de agendamentos/clientes_crm limita ao escopo.';

create or replace function public.ic_agendamento_criar(p_cliente uuid, p_inicio timestamptz, p_fim timestamptz, p_responsavel text, p_titulo text, p_tipo text default 'consulta', p_obs text default null)
returns public.agendamentos
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.clientes_crm;
  u public.users;
  r public.agendamentos;
  resp_nome text;
begin
  select * into c from public.clientes_crm where id = p_cliente and deleted_at is null;
  if c.id is null then
    raise exception 'card % nao existe ou esta excluido', p_cliente;
  end if;
  if p_fim <= p_inicio then
    raise exception 'fim deve ser depois do inicio';
  end if;
  u := public.ic_usuario_atual();
  if not public.ic_card_no_escopo(c.vendedor_id) and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'sem acesso a este card';
  end if;
  select name into resp_nome from public.users where id = p_responsavel;

  insert into public.agendamentos (cliente_crm_id, funil_id, responsavel_id, responsavel_nome, titulo, inicio, fim, tipo, telefone_lead, observacoes, origem, criado_por,
                                   google_sync_status)
  values (c.id, c.funil_id, p_responsavel, resp_nome, coalesce(nullif(btrim(p_titulo), ''), 'Consulta'), p_inicio, p_fim,
          coalesce(p_tipo, 'consulta'), c.telefone, p_obs, 'manual', coalesce(u.id, auth.jwt() ->> 'email', 'service_role'),
          case when public.ic_flag('agendamento_google') then 'pendente' else 'desligado' end)
  returning * into r;
  return r;
end;
$$;
comment on function public.ic_agendamento_criar(uuid, timestamptz, timestamptz, text, text, text, text) is 'IC: cria agendamento preenchendo telefone_lead do card e criado_por do usuario atual. Devolve a linha.';

create or replace function public.ic_agendamento_status(p_id uuid, p_status text)
returns public.agendamentos
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.agendamentos;
  a public.agendamentos;
  c public.clientes_crm;
begin
  select * into a from public.agendamentos where id = p_id;
  if a.id is null then
    raise exception 'agendamento % nao existe', p_id;
  end if;
  select * into c from public.clientes_crm where id = a.cliente_crm_id;
  if not public.ic_card_no_escopo(c.vendedor_id) and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'sem acesso a este card';
  end if;
  update public.agendamentos
  set status = p_status,
      google_sync_status = case when google_sync_status = 'sincronizado' then 'pendente' else google_sync_status end
  where id = p_id
  returning * into r;
  return r;
end;
$$;
comment on function public.ic_agendamento_status(uuid, text) is 'IC: muda o status (pendente/confirmado/cancelado/realizado/faltou). Confirmar dispara o gatilho que move o card e abre o handoff.';

create or replace function public.ic_minha_agenda_google()
returns table (google_email text, ativo boolean, calendar_id text, atualizado_em timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select g.google_email, g.ativo, g.calendar_id, g.atualizado_em
  from public.ic_google_credenciais g
  join public.ic_usuario_atual() u on u.id = g.user_id;
$$;
comment on function public.ic_minha_agenda_google() is 'IC: o que o usuario pode ver da propria credencial Google (nunca o token).';

revoke execute on function public.ic_agendamentos_lista(date, date, text, text) from public, anon;
grant execute on function public.ic_agendamentos_lista(date, date, text, text) to authenticated, service_role;
revoke execute on function public.ic_agendamento_criar(uuid, timestamptz, timestamptz, text, text, text, text) from public, anon;
grant execute on function public.ic_agendamento_criar(uuid, timestamptz, timestamptz, text, text, text, text) to authenticated, service_role;
revoke execute on function public.ic_agendamento_status(uuid, text) from public, anon;
grant execute on function public.ic_agendamento_status(uuid, text) to authenticated, service_role;
revoke execute on function public.ic_minha_agenda_google() from public, anon;
grant execute on function public.ic_minha_agenda_google() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
alter table public.agendamentos enable row level security;
drop policy if exists "ic_agendamentos_select" on public.agendamentos;
drop policy if exists "ic_agendamentos_insert" on public.agendamentos;
drop policy if exists "ic_agendamentos_update" on public.agendamentos;
create policy "ic_agendamentos_select" on public.agendamentos for select to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
create policy "ic_agendamentos_insert" on public.agendamentos for insert to authenticated
  with check (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
create policy "ic_agendamentos_update" on public.agendamentos for update to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
-- delete negado: cancele pelo status.

alter table public.ic_google_credenciais enable row level security;
-- Nenhuma politica: authenticated nao le nem escreve. service_role bypassa.

-- ---------------------------------------------------------------------------
-- 5. Realtime
-- ---------------------------------------------------------------------------
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agendamentos') then
    alter publication supabase_realtime add table public.agendamentos;
  end if;
end
$rt$;

commit;

-- ROLLBACK:
-- begin;
-- do $$ begin if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='agendamentos')
--   then alter publication supabase_realtime drop table public.agendamentos; end if; end $$;
-- drop function if exists public.ic_minha_agenda_google();
-- drop function if exists public.ic_agendamento_status(uuid, text);
-- drop function if exists public.ic_agendamento_criar(uuid, timestamptz, timestamptz, text, text, text, text);
-- drop function if exists public.ic_agendamentos_lista(date, date, text, text);
-- drop trigger if exists trg_agendamento_confirmado on public.agendamentos;
-- drop trigger if exists trg_agendamento_touch on public.agendamentos;
-- drop function if exists public.ic_agendamento_confirmado();
-- drop function if exists public.ic_agendamento_touch();
-- drop table if exists public.ic_google_credenciais;
-- drop table if exists public.agendamentos;
-- commit;
