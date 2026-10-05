-- 16 IC: jobs de rotina e auditoria estendida
-- IC CRM, camada sobre o esquema base (00-12). Depende de 13 (etapa cliente_antigo) e
-- 15 (RLS; as funcoes aqui sao security definer).
--
-- O que faz:
--   1. ic_jobs_log: um resumo por execucao de job.
--   2. crm_reclassificar_antigos(): a "regra dos 30 dias" saiu do front e virou
--      job do banco. Move cards
--      parados em cliente_novo ha mais de 30 dias para cliente_antigo, SO nos
--      funis que tem essa etapa, pulando excluidos e mesclados, e grava uma
--      linha de crm_historico por card (o front nao gravava).
--   3. ic_reclassificados_recentes(): soma das ultimas 24 h (aviso discreto
--      no Kanban).
--   4. pg_cron diario as 03:00 America/Sao_Paulo. Protegido por "se pg_cron
--      existe" (nao existe no PGlite nem fora do Supabase).
--   5. Auditoria (audit_trigger_func, ja existe no 06) em permissoes,
--      perfil_permissoes, perfis_acesso e users. users.pw nunca deve ter
--      senha: o esquema base grava 'supabase_auth' e a auditoria copia a linha inteira.
-- Idempotente.

begin;

-- ---------------------------------------------------------------------------
-- 1. Log de jobs
-- ---------------------------------------------------------------------------
create table if not exists public.ic_jobs_log (
  id           bigserial primary key,
  job          text not null,
  executado_em timestamptz default now(),
  afetados     integer,
  detalhe      jsonb
);
create index if not exists idx_ic_jobs_log_job_data on public.ic_jobs_log (job, executado_em desc);
comment on table public.ic_jobs_log is 'IC: um resumo por execucao de job do banco (crm_reclassificar_antigos e futuros).';

alter table public.ic_jobs_log enable row level security;
drop policy if exists "ic_jobs_log_select" on public.ic_jobs_log;
create policy "ic_jobs_log_select" on public.ic_jobs_log for select to authenticated using (true);
-- insert so pelas funcoes security definer / service_role.

-- ---------------------------------------------------------------------------
-- 2. Regra dos 30 dias como job
-- ---------------------------------------------------------------------------
create or replace function public.crm_reclassificar_antigos()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
  ids uuid[];
begin
  with alvo as (
    select c.id, c.etapa as etapa_anterior
    from public.clientes_crm c
    join public.crm_funil_etapas e
      on e.funil_id = c.funil_id and e.nome = 'cliente_antigo'
    where c.etapa = 'cliente_novo'
      and c.deleted_at is null
      and c.mesclado_para is null
      and c.data_entrada < now() - interval '30 days'
  ),
  movidos as (
    update public.clientes_crm c
    set etapa = 'cliente_antigo', updated_at = now()
    from alvo a
    where c.id = a.id
    returning c.id, a.etapa_anterior
  ),
  hist as (
    insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo)
    select m.id, m.etapa_anterior, 'cliente_antigo', 'Sistema',
           'Movido para Lead Antigo automaticamente: mais de 30 dias sem movimento', 'automatico'
    from movidos m
    returning cliente_id
  )
  select count(*), coalesce(array_agg(cliente_id), '{}'::uuid[]) into n, ids from hist;

  insert into public.ic_jobs_log (job, afetados, detalhe)
  values ('crm_reclassificar_antigos', n, jsonb_build_object('ids', to_jsonb(ids)));

  return n;
end;
$$;
comment on function public.crm_reclassificar_antigos() is 'IC: move cards em cliente_novo ha mais de 30 dias para cliente_antigo (so em funis que tem essa etapa), grava crm_historico tipo automatico e um resumo em ic_jobs_log. Devolve a contagem.';

create or replace function public.ic_reclassificados_recentes()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(afetados), 0)::integer
  from public.ic_jobs_log
  where job = 'crm_reclassificar_antigos'
    and executado_em >= now() - interval '24 hours';
$$;
comment on function public.ic_reclassificados_recentes() is 'IC: quantos cards o job de 30 dias moveu nas ultimas 24 h (aviso discreto no Kanban).';

revoke execute on function public.crm_reclassificar_antigos() from public, anon;
grant execute on function public.crm_reclassificar_antigos() to authenticated, service_role;
revoke execute on function public.ic_reclassificados_recentes() from public, anon;
grant execute on function public.ic_reclassificados_recentes() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. pg_cron: 03:00 America/Sao_Paulo = 06:00 UTC (BRT = UTC-3, sem horario
--    de verao desde 2019). pg_cron agenda em UTC: '0 6 * * *'.
-- ---------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'ic-reclassificar-antigos') then
      perform cron.unschedule('ic-reclassificar-antigos');
    end if;
    perform cron.schedule(
      'ic-reclassificar-antigos',
      '0 6 * * *',
      $job$ select public.crm_reclassificar_antigos() $job$
    );
  else
    raise notice 'pg_cron nao instalado: job ic-reclassificar-antigos nao agendado (normal fora do Supabase)';
  end if;
end
$cron$;

-- ---------------------------------------------------------------------------
-- 4. Auditoria estendida (audit_trigger_func grava em audit_log_critico).
--    users.pw NUNCA deve ter senha (o esquema base grava 'supabase_auth'); a auditoria
--    copia a linha inteira, antes e depois.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_audit_permissoes on public.permissoes;
create trigger trg_audit_permissoes after insert or update or delete on public.permissoes
  for each row execute function public.audit_trigger_func();

drop trigger if exists trg_audit_perfil_permissoes on public.perfil_permissoes;
create trigger trg_audit_perfil_permissoes after insert or update or delete on public.perfil_permissoes
  for each row execute function public.audit_trigger_func();

drop trigger if exists trg_audit_perfis_acesso on public.perfis_acesso;
create trigger trg_audit_perfis_acesso after insert or update or delete on public.perfis_acesso
  for each row execute function public.audit_trigger_func();

drop trigger if exists trg_audit_users on public.users;
create trigger trg_audit_users after insert or update or delete on public.users
  for each row execute function public.audit_trigger_func();

commit;

-- ROLLBACK:
-- begin;
-- drop trigger if exists trg_audit_users on public.users;
-- drop trigger if exists trg_audit_perfis_acesso on public.perfis_acesso;
-- drop trigger if exists trg_audit_perfil_permissoes on public.perfil_permissoes;
-- drop trigger if exists trg_audit_permissoes on public.permissoes;
-- do $$ begin if exists (select 1 from pg_extension where extname='pg_cron')
--   and exists (select 1 from cron.job where jobname='ic-reclassificar-antigos')
--   then perform cron.unschedule('ic-reclassificar-antigos'); end if; end $$;
-- drop function if exists public.ic_reclassificados_recentes();
-- drop function if exists public.crm_reclassificar_antigos();
-- drop table if exists public.ic_jobs_log;
-- commit;
-- (os cards ja movidos ficam em cliente_antigo; o crm_historico diz quais)
