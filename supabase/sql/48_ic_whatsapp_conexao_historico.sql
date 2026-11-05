-- 48 Estado e historico da conexao do WhatsApp (Z-API) + tela WhatsApp.
--
-- O que muda:
--   vendedores_whatsapp ganha 3 colunas (nulas, sem reescrever a tabela):
--     zapi_estado        'conectado' | 'desconectado' (null = nunca conferido)
--     zapi_estado_desde  quando entrou no estado atual
--     zapi_conferido_em  ultima vez que alguem conferiu (aviso da Z-API,
--                        conferencia automatica ou a tela). Serve de "cache":
--                        a faixa le o banco e so pergunta a Z-API 1x/minuto.
--   ic_whatsapp_conexao_eventos   cada vez que o numero CAIU ou VOLTOU:
--                        quando, origem (zapi = aviso da Z-API na hora,
--                        consulta = conferencia automatica, tela = acao de um
--                        Admin), quem fez. Nao guarda mensagem nem telefone de
--                        lead (LGPD): so o numero da casa, hora e usuario.
--   ic_whatsapp_registrar_estado(...)  UNICO jeito de gravar o estado. So
--                        registra evento quando o estado MUDA (aviso da Z-API
--                        e conferencia nao duplicam), abre/fecha a queda em
--                        ic_whatsapp_quedas (SQL 41, usada pela retomada da
--                        Jully) e grava no Historico de alteracoes
--                        (audit_log_critico, tabela 'whatsapp').
--   ic_whatsapp_reservar_conferencia(...)  so a primeira chamada depois do
--                        prazo ganha true (varias abas nao chamam a Z-API juntas).
--
-- So service_role le e executa (as Edge Functions). O navegador NAO le estas
-- tabelas direto: tudo passa pela funcao ic-whatsapp-conexao.
--
-- SO ADITIVA. Backup feito antes em bkp_20261105 (vendedores_whatsapp e
-- ic_whatsapp_quedas). Idempotente. ROLLBACK no fim.
--
-- Ordem de publicacao: rodar ESTE SQL antes de publicar ic-meta-webhook,
-- ic-whatsapp-conexao e ic-ia-pre-atendimento novos.

-- 1) Colunas de estado
alter table public.vendedores_whatsapp
  add column if not exists zapi_estado text,
  add column if not exists zapi_estado_desde timestamptz,
  add column if not exists zapi_conferido_em timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vendedores_whatsapp_zapi_estado_check') then
    alter table public.vendedores_whatsapp
      add constraint vendedores_whatsapp_zapi_estado_check
      check (zapi_estado is null or zapi_estado in ('conectado', 'desconectado'));
  end if;
end $$;

-- 2) Historico de conexoes
create table if not exists public.ic_whatsapp_conexao_eventos (
  id          uuid primary key default gen_random_uuid(),
  linha_id    uuid not null references public.vendedores_whatsapp(id) on delete cascade,
  estado      text not null check (estado in ('conectado', 'desconectado')),
  origem      text not null check (origem in ('zapi', 'consulta', 'tela')),
  usuario_id  uuid,
  criado_em   timestamptz not null default now()
);
comment on table public.ic_whatsapp_conexao_eventos is 'IC: cada queda e reconexao do WhatsApp (Z-API). So service_role.';
create index if not exists ic_whatsapp_conexao_eventos_linha
  on public.ic_whatsapp_conexao_eventos (linha_id, criado_em desc);
alter table public.ic_whatsapp_conexao_eventos enable row level security;
revoke all on public.ic_whatsapp_conexao_eventos from public, anon, authenticated;

-- 3) Registrar estado (aviso da Z-API, conferencia ou tela)
--    p_queda_desde: inicio da queda em ic_whatsapp_quedas (a retomada da
--    Jully usa uma folga antes da hora detectada). null = agora.
--    Devolve { ok, mudou, estado, desde }.
create or replace function public.ic_whatsapp_registrar_estado(
  p_linha_id    uuid,
  p_conectado   boolean,
  p_origem      text,
  p_usuario_id  uuid default null,
  p_queda_desde timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_linha  public.vendedores_whatsapp%rowtype;
  v_estado text := case when p_conectado then 'conectado' else 'desconectado' end;
  v_mudou  boolean;
  v_evento uuid;
  v_agora  timestamptz := now();
begin
  if p_origem not in ('zapi', 'consulta', 'tela') then
    raise exception 'origem invalida';
  end if;

  select * into v_linha from public.vendedores_whatsapp where id = p_linha_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'linha_nao_encontrada');
  end if;

  v_mudou := v_linha.zapi_estado is distinct from v_estado;

  update public.vendedores_whatsapp
     set zapi_conferido_em = v_agora,
         zapi_estado       = v_estado,
         zapi_estado_desde = case when v_mudou then v_agora else coalesce(zapi_estado_desde, v_agora) end
   where id = p_linha_id;

  -- Queda (SQL 41): abre ao cair, fecha ao voltar. Idempotente.
  if p_conectado then
    update public.ic_whatsapp_quedas
       set reconectado_em = v_agora
     where linha_id = p_linha_id and reconectado_em is null;
  else
    insert into public.ic_whatsapp_quedas (linha_id, desconectado_em)
    select p_linha_id, coalesce(p_queda_desde, v_agora)
     where not exists (select 1 from public.ic_whatsapp_quedas
                        where linha_id = p_linha_id and reconectado_em is null)
    on conflict do nothing;
  end if;

  if v_mudou then
    insert into public.ic_whatsapp_conexao_eventos (linha_id, estado, origem, usuario_id)
    values (p_linha_id, v_estado, p_origem, p_usuario_id)
    returning id into v_evento;

    insert into public.audit_log_critico (tabela, operacao, registro_id, user_id, dados_antes, dados_depois)
    values ('whatsapp', 'UPDATE', v_evento::text, p_usuario_id::text,
            jsonb_build_object('estado', v_linha.zapi_estado),
            jsonb_build_object(
              'estado', v_estado,
              'origem', p_origem,
              'nome', case when p_conectado then 'WhatsApp conectado' else 'WhatsApp desconectado' end
                      || coalesce(' (final ' || right(regexp_replace(coalesce(v_linha.numero_whatsapp, ''), '\D', '', 'g'), 4) || ')', '')));
  end if;

  return jsonb_build_object(
    'ok', true,
    'mudou', v_mudou,
    'estado', v_estado,
    'desde', (select zapi_estado_desde from public.vendedores_whatsapp where id = p_linha_id));
end;
$$;

-- 4) Reserva da conferencia na Z-API (cache de N segundos por numero)
create or replace function public.ic_whatsapp_reservar_conferencia(p_linha_id uuid, p_segundos integer default 60)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with r as (
    update public.vendedores_whatsapp
       set zapi_conferido_em = now()
     where id = p_linha_id
       and (zapi_conferido_em is null
            or zapi_conferido_em < now() - make_interval(secs => greatest(coalesce(p_segundos, 60), 10)))
    returning 1)
  select exists (select 1 from r);
$$;

revoke all on function public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.ic_whatsapp_reservar_conferencia(uuid, integer) from public, anon, authenticated;
grant execute on function public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz) to service_role;
grant execute on function public.ic_whatsapp_reservar_conferencia(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- drop function if exists public.ic_whatsapp_reservar_conferencia(uuid, integer);
-- drop function if exists public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz);
-- drop table if exists public.ic_whatsapp_conexao_eventos;
-- alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_zapi_estado_check;
-- alter table public.vendedores_whatsapp drop column if exists zapi_conferido_em,
--   drop column if exists zapi_estado_desde, drop column if exists zapi_estado;
-- delete from public.audit_log_critico where tabela = 'whatsapp';   -- opcional
