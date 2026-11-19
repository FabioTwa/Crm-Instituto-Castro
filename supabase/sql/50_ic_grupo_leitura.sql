-- 50 Leitura de grupo do WhatsApp (somente leitura) - grupo "Treinamento Jully".
--
-- Pedido do Fabio (19/11/2026): o numero oficial foi adicionado ao grupo
-- "Treinamento Jully". O CRM so GUARDA as mensagens desse grupo, para leitura.
--
-- Regras (garantidas no ic-meta-webhook, nao aqui):
--   - nunca envia nada no grupo;
--   - a Jully/IA nao le nem responde mensagem de grupo;
--   - grupo nunca vira card de lead/paciente nem dispara aviso;
--   - qualquer outro grupo continua descartado.
--
-- Tabelas:
--   ic_grupos_leitura    lista branca de grupos lidos. A linha nasce com o
--                        NOME e grupo_id vazio. Na primeira mensagem de um grupo
--                        com esse nome exato, o webhook grava o id do grupo
--                        (so uma vez: update ... where grupo_id is null). Dali
--                        em diante vale SO o id (renomear outro grupo para o
--                        mesmo nome nao entra).
--   ic_grupo_mensagens   as mensagens. Dados de terceiros (LGPD): so Admin le
--                        pelo app; so service_role (o webhook) grava.
--
-- SO ADITIVA (tabelas novas). Idempotente. ROLLBACK no fim.

-- 1) Grupos lidos
create table if not exists public.ic_grupos_leitura (
  id          bigint generated always as identity primary key,
  nome        text not null,
  grupo_id    text unique,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now(),
  vinculado_em timestamptz
);
comment on table public.ic_grupos_leitura is 'IC (SQL 50): grupos do WhatsApp que o CRM guarda so para leitura. grupo_id e preenchido pelo webhook na 1a mensagem com o nome exato.';

insert into public.ic_grupos_leitura (nome)
select 'Treinamento Jully'
where not exists (select 1 from public.ic_grupos_leitura where nome = 'Treinamento Jully');

-- 2) Mensagens
create table if not exists public.ic_grupo_mensagens (
  id              bigint generated always as identity primary key,
  grupo_id        text not null,
  grupo_nome      text,
  message_id      text not null,
  autor_telefone  text,
  autor_nome      text,
  de_mim          boolean not null default false,
  tipo            text not null,
  texto           text,
  midia_url       text,
  transcricao     text,
  enviada_em      timestamptz,
  recebida_em     timestamptz not null default now(),
  constraint ic_grupo_mensagens_unica unique (grupo_id, message_id)
);
create index if not exists ic_grupo_mensagens_grupo_data on public.ic_grupo_mensagens (grupo_id, enviada_em desc);
comment on table public.ic_grupo_mensagens is 'IC (SQL 50): mensagens dos grupos de ic_grupos_leitura, so leitura. Dados de terceiros (LGPD): RLS so Admin.';

-- 3) RLS: so Admin le; ninguem grava pelo app (o webhook usa service_role)
alter table public.ic_grupos_leitura enable row level security;
alter table public.ic_grupo_mensagens enable row level security;

drop policy if exists "ic_grupos_leitura_admin_le" on public.ic_grupos_leitura;
create policy "ic_grupos_leitura_admin_le" on public.ic_grupos_leitura
  for select to authenticated using (public.ic_eh_admin());

drop policy if exists "ic_grupo_mensagens_admin_le" on public.ic_grupo_mensagens;
create policy "ic_grupo_mensagens_admin_le" on public.ic_grupo_mensagens
  for select to authenticated using (public.ic_eh_admin());

revoke all on public.ic_grupos_leitura from anon, authenticated;
revoke all on public.ic_grupo_mensagens from anon, authenticated;
grant select on public.ic_grupos_leitura to authenticated;
grant select on public.ic_grupo_mensagens to authenticated;
grant all on public.ic_grupos_leitura to service_role;
grant all on public.ic_grupo_mensagens to service_role;

-- ROLLBACK (apaga as mensagens guardadas; fazer backup antes se quiser manter):
-- drop table if exists public.ic_grupo_mensagens;
-- drop table if exists public.ic_grupos_leitura;
