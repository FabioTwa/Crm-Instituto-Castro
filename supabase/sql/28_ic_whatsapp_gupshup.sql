-- 28 WhatsApp pelo Gupshup (BSP da Meta, modo coexistencia).
--
-- Cada numero de vendedores_whatsapp passa a dizer por qual provedor ele
-- envia e recebe:
--   provedor = 'meta'    Cloud API direta (meta_phone_id + META_ACCESS_TOKEN). Padrao: nada muda.
--   provedor = 'gupshup' Gupshup (gupshup_app + numero_whatsapp + GUPSHUP_API_KEY).
--
-- gupshup_app    nome do app no painel do Gupshup (o "src.name" do envio e o
--                campo "app" do webhook no formato Gupshup).
-- gupshup_app_id id do app no Gupshup (campo "gs_app_id" do webhook no formato
--                Meta). Opcional: sem ele o webhook acha o numero pelo nome do
--                app ou por meta_phone_id.
--
-- crm_entrada_bruta passa a aceitar origem 'gupshup' (envelope cru do webhook).
--
-- Aditivo: so colunas novas com padrao, constraint nova e uma constraint
-- trocada por outra mais larga. Nenhum dado existente muda.
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

alter table public.vendedores_whatsapp
  add column if not exists provedor text not null default 'meta',
  add column if not exists gupshup_app text,
  add column if not exists gupshup_app_id text;

comment on column public.vendedores_whatsapp.provedor is 'IC: provedor do WhatsApp deste numero: meta (Cloud API direta) ou gupshup (BSP, coexistencia).';
comment on column public.vendedores_whatsapp.gupshup_app is 'IC: nome do app no painel do Gupshup (src.name no envio, "app" no webhook v2).';
comment on column public.vendedores_whatsapp.gupshup_app_id is 'IC: id do app no Gupshup ("gs_app_id" no webhook formato Meta). Opcional.';

alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_provedor_check;
alter table public.vendedores_whatsapp
  add constraint vendedores_whatsapp_provedor_check
  check (provedor in ('meta', 'gupshup'));

-- Numero do Gupshup sem nome de app nao consegue enviar nem ser achado pelo webhook.
alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_gupshup_app_check;
alter table public.vendedores_whatsapp
  add constraint vendedores_whatsapp_gupshup_app_check
  check (provedor <> 'gupshup' or nullif(btrim(gupshup_app), '') is not null);

-- Um app do Gupshup pertence a um numero ativo so: senao o webhook nao sabe
-- de quem e a mensagem.
create unique index if not exists vendedores_whatsapp_gupshup_app_unico
  on public.vendedores_whatsapp (lower(btrim(gupshup_app)))
  where ativo and gupshup_app is not null;
create unique index if not exists vendedores_whatsapp_gupshup_app_id_unico
  on public.vendedores_whatsapp (btrim(gupshup_app_id))
  where ativo and gupshup_app_id is not null;

alter table public.crm_entrada_bruta drop constraint if exists crm_entrada_bruta_origem_check;
alter table public.crm_entrada_bruta
  add constraint crm_entrada_bruta_origem_check
  check (origem = any (array['meta'::text, 'zapi'::text, 'gupshup'::text]));

-- ---------------------------------------------------------------------------
-- COMO LIGAR UM NUMERO NO GUPSHUP (rodar a mao, trocando os < >):
--
-- update public.vendedores_whatsapp
-- set provedor = 'gupshup',
--     gupshup_app = '<NOME_DO_APP_NO_GUPSHUP>',
--     numero_whatsapp = '<5511900000000>'          -- o numero conectado no Gupshup, so digitos
-- where vendedor_id = '<ID_DO_VENDEDOR>';
--
-- Voltar para a Cloud API direta: set provedor = 'meta' (gupshup_app pode ficar).

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- (antes, voltar os numeros para a Meta: update public.vendedores_whatsapp set provedor = 'meta';
--  e conferir que nao ha crm_entrada_bruta com origem 'gupshup', ou apaga-las depois de processadas)
-- alter table public.crm_entrada_bruta drop constraint if exists crm_entrada_bruta_origem_check;
-- alter table public.crm_entrada_bruta add constraint crm_entrada_bruta_origem_check
--   check (origem = any (array['meta'::text, 'zapi'::text]));
-- drop index if exists public.vendedores_whatsapp_gupshup_app_id_unico;
-- drop index if exists public.vendedores_whatsapp_gupshup_app_unico;
-- alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_gupshup_app_check;
-- alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_provedor_check;
-- alter table public.vendedores_whatsapp drop column if exists gupshup_app_id;
-- alter table public.vendedores_whatsapp drop column if exists gupshup_app;
-- alter table public.vendedores_whatsapp drop column if exists provedor;
