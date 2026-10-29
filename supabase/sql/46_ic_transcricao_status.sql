-- 46 Status da transcricao de audio + funcao de saude (alerta de transcricao).
--
-- Cada audio em crm_conversas passa a guardar (gravado pelo ic-meta-webhook,
-- _shared/transcricao.ts):
--   transcricao_status      pendente | ok | falhou | ignorado (null = linha
--                           antiga ou mensagem que nao e audio)
--   transcricao_erro        motivo CURTO, so codigo fixo (ex.: groq_429,
--                           groq_http_500, download_falhou). A trava de formato
--                           abaixo impede texto livre e, com isso, dado pessoal.
--   transcricao_tentativas  quantas vezes a Groq foi chamada para este audio
--   transcrita_em           hora em que a transcricao deu certo
--
-- ic_alertas_estado: memoria da rotina de alerta (o que ja foi avisado).
-- ic_saude_transcricao(): leitura so, para o servidor (service_role). O
-- navegador (anon/authenticated) NAO executa. Devolve numeros e codigos, nunca
-- texto de mensagem, telefone ou nome.
--
-- SO ADITIVA: colunas novas (nulas ou com default constante, sem reescrever a
-- tabela), um indice parcial, uma funcao e uma tabela nova. Nao altera nem apaga dado.
-- Antes: guarda copia de crm_conversas em crm_conversas_bkp_46 (RLS ligado,
-- sem acesso pela API). Idempotente. ROLLBACK no fim.
--
-- Ordem de publicacao: rodar ESTE SQL antes de publicar o ic-meta-webhook
-- novo (se a funcao subir antes, ela grava o audio sem status, sem perder nada).

-- 1) Backup
create table if not exists public.crm_conversas_bkp_46 as
  select * from public.crm_conversas;
alter table public.crm_conversas_bkp_46 enable row level security;
revoke all on public.crm_conversas_bkp_46 from public, anon, authenticated;
comment on table public.crm_conversas_bkp_46 is 'IC: copia de crm_conversas antes do SQL 46 (29/10/2026). Pode apagar depois de validado.';

-- 2) Colunas novas
alter table public.crm_conversas
  add column if not exists transcricao_status text,
  add column if not exists transcricao_erro text,
  add column if not exists transcricao_tentativas integer not null default 0,
  add column if not exists transcrita_em timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_conversas_transcricao_status_chk') then
    alter table public.crm_conversas add constraint crm_conversas_transcricao_status_chk
      check (transcricao_status is null or transcricao_status in ('pendente', 'ok', 'falhou', 'ignorado'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_conversas_transcricao_erro_chk') then
    alter table public.crm_conversas add constraint crm_conversas_transcricao_erro_chk
      check (transcricao_erro is null or transcricao_erro ~ '^[a-z0-9_]{1,40}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_conversas_transcricao_tentativas_chk') then
    alter table public.crm_conversas add constraint crm_conversas_transcricao_tentativas_chk
      check (transcricao_tentativas between 0 and 50);
  end if;
end $$;

comment on column public.crm_conversas.transcricao_status is 'IC: pendente | ok | falhou | ignorado (so audio)';
comment on column public.crm_conversas.transcricao_erro is 'IC: codigo curto do motivo, sem dado pessoal';
comment on column public.crm_conversas.transcricao_tentativas is 'IC: chamadas a Groq para este audio (429 conta como tentativa)';
comment on column public.crm_conversas.transcrita_em is 'IC: hora em que a transcricao deu certo';

-- 3) Indice para a funcao de saude e para o varredor (so linhas de audio)
create index if not exists crm_conversas_audio_criada_em
  on public.crm_conversas (criada_em desc)
  where tipo = 'audio';

-- 4) Funcao de saude (so leitura, so servidor)
create or replace function public.ic_saude_transcricao()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with a as (
    select transcricao_status as st, transcricao_erro as erro, criada_em, transcrita_em
      from public.crm_conversas
     where tipo = 'audio'
       and transcricao_status is not null
  ),
  ultimo_erro as (
    select erro, criada_em
      from a
     where erro is not null and st in ('falhou', 'pendente')
     order by criada_em desc
     limit 1
  )
  select jsonb_build_object(
    'gerado_em',                now(),
    'ultimo_sucesso_em',        (select max(transcrita_em) from a where st = 'ok'),
    'falhas_2h',                (select count(*) from a where st = 'falhou' and criada_em >= now() - interval '2 hours'),
    'pendentes_travados_15min', (select count(*) from a where st = 'pendente' and criada_em < now() - interval '15 minutes'),
    'ultimo_erro_motivo',       (select erro from ultimo_erro),
    'ultimo_erro_em',           (select criada_em from ultimo_erro),
    'recebidos_2h',             (select count(*) from a where st <> 'ignorado' and criada_em >= now() - interval '2 hours'),
    'sucessos_2h',              (select count(*) from a where st = 'ok' and criada_em >= now() - interval '2 hours'),
    'ignorados_2h',             (select count(*) from a where st = 'ignorado' and criada_em >= now() - interval '2 hours'),
    'transcricao_ligada',       public.ic_flag('ia_transcricao_audio')
  );
$$;

comment on function public.ic_saude_transcricao() is 'IC: saude da transcricao de audio (so leitura, so service_role).';
revoke all on function public.ic_saude_transcricao() from public, anon, authenticated;
grant execute on function public.ic_saude_transcricao() to service_role;

-- 5) Estado dos alertas (usado pela rotina horaria que confere a saude):
-- um registro por problema aberto, para avisar 1 vez, repetir a cada 6 h e
-- avisar de novo quando voltar ao normal. So service_role. Sem dado pessoal.
create table if not exists public.ic_alertas_estado (
  chave            text primary key,          -- ex.: 'transcricao:falhas'
  aberto_em        timestamptz not null default now(),
  ultimo_aviso_em  timestamptz not null default now(),
  avisos           integer not null default 1,
  detalhe          jsonb
);
comment on table public.ic_alertas_estado is 'IC: problemas abertos dos alertas operacionais (rotina horaria). So service_role.';
alter table public.ic_alertas_estado enable row level security;
revoke all on public.ic_alertas_estado from public, anon, authenticated;
grant select, insert, update, delete on public.ic_alertas_estado to service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- drop table if exists public.ic_alertas_estado;
-- drop function if exists public.ic_saude_transcricao();
-- drop index if exists public.crm_conversas_audio_criada_em;
-- alter table public.crm_conversas
--   drop constraint if exists crm_conversas_transcricao_status_chk,
--   drop constraint if exists crm_conversas_transcricao_erro_chk,
--   drop constraint if exists crm_conversas_transcricao_tentativas_chk,
--   drop column if exists transcricao_status,
--   drop column if exists transcricao_erro,
--   drop column if exists transcricao_tentativas,
--   drop column if exists transcrita_em;
-- (depois de validado) drop table if exists public.crm_conversas_bkp_46;
