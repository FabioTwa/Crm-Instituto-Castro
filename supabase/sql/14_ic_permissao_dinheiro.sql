-- 14 IC: usuario atual, flags de recurso e permissao de dinheiro
-- IC CRM, camada sobre o esquema base (00-12). Depende de 13 (perfis_acesso.ve_dinheiro).
--
-- O que faz:
--   1. ic_feature_flags: liga/desliga recursos sem mexer em codigo.
--   2. ic_usuario_atual(): a linha de public.users do usuario logado. O front
--      usa Supabase Auth e a linha e casada por E-MAIL (users.email = e-mail
--      do JWT); users.id e um text aleatorio, NAO e auth.uid().
--   3. ic_eh_admin(), ic_perfil_nome(), ic_pode_ver_dinheiro(), ic_flag().
--      ic_pode_ver_dinheiro() e a UNICA fonte de verdade de quem ve valores.
--   4. Enforcement no banco das 3 RPCs de dinheiro base, por funcoes novas
--      (ic_*) com a MESMA assinatura, que chamam a original e tiram as chaves
--      monetarias quando o usuario nao pode ver. As originais nao mudam.
--
-- Todas as funcoes aqui sao SECURITY DEFINER com search_path fixo: elas
-- precisam ler users/perfis_acesso por baixo da RLS do arquivo 15.
-- Idempotente.

begin;

-- ---------------------------------------------------------------------------
-- 1. Flags de recurso
-- ---------------------------------------------------------------------------
create table if not exists public.ic_feature_flags (
  chave          text primary key,
  ligada         boolean not null default false,
  descricao      text,
  atualizada_em  timestamptz default now(),
  atualizada_por text
);
comment on table public.ic_feature_flags is 'IC: liga/desliga recursos (envio WhatsApp, IA, Google Agenda). Lida por ic_flag(chave). Escrita so por Admin (RLS no 15).';

insert into public.ic_feature_flags (chave, ligada, descricao) values
  ('envio_whatsapp_cloud_api', false, 'Envio de mensagem pelo CRM via WhatsApp Cloud API (Meta)'),
  ('ia_pre_atendimento',       false, 'IA responde o lead antes do humano (17_ic_ia.sql)'),
  ('agendamento_google',       false, 'Sincroniza agendamentos com Google Agenda (18_ic_agendamentos.sql)'),
  ('ia_transcricao_audio',     true,  'Transcreve audios recebidos para texto')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Usuario atual (por e-mail do JWT)
-- ---------------------------------------------------------------------------
create or replace function public.ic_usuario_atual()
returns public.users
language sql
stable
security definer
set search_path = public
as $$
  select u.*
  from public.users u
  where lower(u.email) = lower(nullif(auth.jwt() ->> 'email', ''))
  order by (u.status = 'ativo') desc, u.created_at
  limit 1;
$$;
comment on function public.ic_usuario_atual() is 'IC: linha de public.users casada por e-mail com o JWT do Supabase Auth. Nula se nao autenticado ou sem linha.';

create or replace function public.ic_perfil_nome()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.nome from public.perfis_acesso p where p.id = u.perfil_id),
    u.perfil
  )
  from public.ic_usuario_atual() u
  where u.id is not null;
$$;
comment on function public.ic_perfil_nome() is 'IC: nome tecnico do perfil do usuario atual (Admin, Vendedor, SDR, Financeiro). Prefere perfil_id; cai para users.perfil.';

create or replace function public.ic_eh_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select coalesce(p.is_admin, false) or coalesce(u.perfil, '') = 'Admin'
    from public.ic_usuario_atual() u
    left join public.perfis_acesso p on p.id = u.perfil_id
    where u.id is not null
  ), false);
$$;
comment on function public.ic_eh_admin() is 'IC: true se o perfil do usuario atual tem is_admin (ou users.perfil = Admin sem perfil_id).';

create or replace function public.ic_pode_ver_dinheiro()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- service_role (Edge Functions, jobs): sempre.
    when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
    when coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' then true
    -- nao autenticado: nunca.
    when nullif(auth.jwt() ->> 'email', '') is null then false
    else coalesce((
      select coalesce(p.is_admin, false) or coalesce(p.ve_dinheiro, false)
             or coalesce(u.perfil, '') = 'Admin'
      from public.ic_usuario_atual() u
      left join public.perfis_acesso p on p.id = u.perfil_id
      where u.id is not null
    ), false)
  end;
$$;
comment on function public.ic_pode_ver_dinheiro() is 'IC: UNICA fonte de verdade de quem ve valores: is_admin ou ve_dinheiro do perfil. service_role true; anonimo false.';

create or replace function public.ic_flag(p_chave text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select ligada from public.ic_feature_flags where chave = p_chave), false);
$$;
comment on function public.ic_flag(text) is 'IC: valor de ic_feature_flags.ligada; false se a chave nao existe.';

-- ---------------------------------------------------------------------------
-- 3. Enforcement nas RPCs de dinheiro base.
--    Campos monetarios inspecionados em 06_funcoes.sql:
--
--    crm_atendimento_resumo(p_inicio, p_fim, p_vendedores) -> jsonb
--      correlacao[].ticket_medio        (media de vendas.valor por faixa)
--      (topo, faixas, por_vendedor, gargalos, prospectados, ressalvas: contagens)
--
--    mkt_anuncios_resumo(p_ini, p_fim, p_vendedores, p_funil, p_agrupar, p_com_dinheiro) -> jsonb
--      total.valor_atribuidos, total.valor_sem_atribuicao
--      linhas[].valor, .ticket, .gasto, .anuncios_com_gasto, .custo_por_lead, .custo_por_venda
--      A original ja omite tudo isso quando p_com_dinheiro = false e marca
--      dinheiro_omitido = true; a ic_ forca p_com_dinheiro = false para quem
--      nao pode ver.
--
--    crm_analise_origem_conversao(p_vendedor, p_data_ini, p_data_fim, p_modo) -> table
--      valor_total                      (soma de valor_pago dos convertidos)
-- ---------------------------------------------------------------------------
create or replace function public.ic_atendimento_resumo(p_inicio date, p_fim date, p_vendedores text[] default null::text[])
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  r jsonb;
begin
  r := public.crm_atendimento_resumo(p_inicio, p_fim, p_vendedores);
  if r is null then return null; end if;
  if not public.ic_pode_ver_dinheiro() then
    r := jsonb_set(
      r,
      '{correlacao}',
      coalesce((select jsonb_agg(e - 'ticket_medio') from jsonb_array_elements(coalesce(r -> 'correlacao', '[]'::jsonb)) e), '[]'::jsonb)
    ) || jsonb_build_object('dinheiro_omitido', true);
  else
    r := r || jsonb_build_object('dinheiro_omitido', false);
  end if;
  return r;
end;
$$;
comment on function public.ic_atendimento_resumo(date, date, text[]) is 'IC: crm_atendimento_resumo sem correlacao[].ticket_medio quando not ic_pode_ver_dinheiro(). Acrescenta dinheiro_omitido.';

create or replace function public.ic_anuncios_resumo(p_ini date, p_fim date, p_vendedores text[] default null::text[], p_funil uuid default null::uuid, p_agrupar text default 'titulo'::text, p_com_dinheiro boolean default false)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select public.mkt_anuncios_resumo(
    p_ini, p_fim, p_vendedores, p_funil, p_agrupar,
    coalesce(p_com_dinheiro, false) and public.ic_pode_ver_dinheiro()
  );
$$;
comment on function public.ic_anuncios_resumo(date, date, text[], uuid, text, boolean) is 'IC: mkt_anuncios_resumo com p_com_dinheiro forcado a false quando not ic_pode_ver_dinheiro() (a original ja omite valor, ticket, gasto, custo_*).';

create or replace function public.ic_origem_conversao(p_vendedor text default null::text, p_data_ini date default null::date, p_data_fim date default null::date, p_modo text default null::text)
returns table(origem_rotulo text, recebidos bigint, avancaram bigint, vendas bigint, taxa_conv numeric, valor_total numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select o.origem_rotulo, o.recebidos, o.avancaram, o.vendas, o.taxa_conv,
         case when public.ic_pode_ver_dinheiro() then o.valor_total else null::numeric end as valor_total
  from public.crm_analise_origem_conversao(p_vendedor, p_data_ini, p_data_fim, p_modo) o;
$$;
comment on function public.ic_origem_conversao(text, date, date, text) is 'IC: crm_analise_origem_conversao com valor_total nulo quando not ic_pode_ver_dinheiro().';

-- ---------------------------------------------------------------------------
-- 4. Concessoes: authenticated chama; anon nao.
-- ---------------------------------------------------------------------------
revoke execute on function public.ic_usuario_atual() from public, anon;
revoke execute on function public.ic_perfil_nome() from public, anon;
revoke execute on function public.ic_eh_admin() from public, anon;
revoke execute on function public.ic_pode_ver_dinheiro() from public, anon;
revoke execute on function public.ic_flag(text) from public, anon;
revoke execute on function public.ic_atendimento_resumo(date, date, text[]) from public, anon;
revoke execute on function public.ic_anuncios_resumo(date, date, text[], uuid, text, boolean) from public, anon;
revoke execute on function public.ic_origem_conversao(text, date, date, text) from public, anon;

grant execute on function public.ic_usuario_atual() to authenticated, service_role;
grant execute on function public.ic_perfil_nome() to authenticated, service_role;
grant execute on function public.ic_eh_admin() to authenticated, service_role;
grant execute on function public.ic_pode_ver_dinheiro() to authenticated, service_role;
grant execute on function public.ic_flag(text) to authenticated, service_role;
grant execute on function public.ic_atendimento_resumo(date, date, text[]) to authenticated, service_role;
grant execute on function public.ic_anuncios_resumo(date, date, text[], uuid, text, boolean) to authenticated, service_role;
grant execute on function public.ic_origem_conversao(text, date, date, text) to authenticated, service_role;

-- Politicas de RLS rodam como a role da sessao. As do 15 chamam
-- ic_eh_admin()/ic_usuario_atual()/ic_perfil_nome() em politicas que valem
-- para anon tambem (audit_log insert). anon precisa poder EXECUTAR estas tres
-- (e so recebe false/nulo, porque nao tem e-mail no JWT).
grant execute on function public.ic_usuario_atual() to anon;
grant execute on function public.ic_eh_admin() to anon;
grant execute on function public.ic_perfil_nome() to anon;

commit;

-- ROLLBACK:
-- begin;
-- drop function if exists public.ic_origem_conversao(text, date, date, text);
-- drop function if exists public.ic_anuncios_resumo(date, date, text[], uuid, text, boolean);
-- drop function if exists public.ic_atendimento_resumo(date, date, text[]);
-- drop function if exists public.ic_flag(text);
-- drop function if exists public.ic_pode_ver_dinheiro();
-- drop function if exists public.ic_eh_admin();
-- drop function if exists public.ic_perfil_nome();
-- drop function if exists public.ic_usuario_atual();
-- drop table if exists public.ic_feature_flags;
-- commit;
-- (o 15 depende destas funcoes: rode o rollback do 15 antes)
