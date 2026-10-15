-- 31 WhatsApp pela Z-API (fase de treino da IA).
--
-- ATENCAO: a Z-API NAO e API oficial da Meta (conecta o numero como aparelho
-- do WhatsApp Web). Ha risco de banimento do numero. Usada so para treinar a
-- IA enquanto o Gupshup aguarda a verificacao da Meta.
--
-- vendedores_whatsapp.provedor passa a aceitar 'zapi':
--   provedor = 'zapi'  envia e recebe pela instancia da Z-API cujo ID esta em
--                      zapi_instancia (coluna que ja existia). Os tokens ficam
--                      nos segredos das funcoes (ZAPI_INSTANCE_TOKEN e
--                      ZAPI_CLIENT_TOKEN), nunca no banco: a coluna antiga
--                      zapi_token NAO e usada.
-- crm_entrada_bruta ja aceita origem 'zapi' (SQL 28).
--
-- Aditivo: so troca constraints por outras mais largas e cria um indice.
-- Nenhum dado existente muda.
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_provedor_check;
alter table public.vendedores_whatsapp
  add constraint vendedores_whatsapp_provedor_check
  check (provedor in ('meta', 'gupshup', 'zapi'));

comment on column public.vendedores_whatsapp.provedor is 'IC: provedor do WhatsApp deste numero: meta (Cloud API direta), gupshup (BSP, coexistencia) ou zapi (treino da IA, nao oficial).';
comment on column public.vendedores_whatsapp.zapi_instancia is 'IC: ID da instancia na Z-API (provedor zapi). Os tokens ficam nos segredos das funcoes.';

-- Numero da Z-API sem instancia nao consegue enviar nem ser achado pelo webhook.
alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_zapi_instancia_check;
alter table public.vendedores_whatsapp
  add constraint vendedores_whatsapp_zapi_instancia_check
  check (provedor <> 'zapi' or nullif(btrim(zapi_instancia), '') is not null);

-- Uma instancia pertence a um numero ativo so: senao o webhook nao sabe de quem e a mensagem.
create unique index if not exists vendedores_whatsapp_zapi_instancia_unico
  on public.vendedores_whatsapp (btrim(zapi_instancia))
  where ativo and provedor = 'zapi';

-- ---------------------------------------------------------------------------
-- COMO LIGAR O NUMERO NA Z-API (rodar a mao, trocando os < >):
--
-- update public.vendedores_whatsapp
-- set provedor = 'zapi',
--     zapi_instancia = '<ID_DA_INSTANCIA>',
--     numero_whatsapp = '<5511900000000>'   -- o numero conectado na Z-API, so digitos
-- where id = '<ID_DA_LINHA>';
--
-- Voltar para o Gupshup: set provedor = 'gupshup' (e o numero antigo, se mudou).
-- gupshup_app e gupshup_app_id continuam guardados na linha.

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- (antes, voltar os numeros: update public.vendedores_whatsapp set provedor = 'gupshup' where provedor = 'zapi';)
-- drop index if exists public.vendedores_whatsapp_zapi_instancia_unico;
-- alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_zapi_instancia_check;
-- alter table public.vendedores_whatsapp drop constraint if exists vendedores_whatsapp_provedor_check;
-- alter table public.vendedores_whatsapp add constraint vendedores_whatsapp_provedor_check
--   check (provedor in ('meta', 'gupshup'));
