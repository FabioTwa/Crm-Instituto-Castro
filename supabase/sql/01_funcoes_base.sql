-- 01 Funcoes base
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- Vem antes das tabelas porque tres colunas GERADAS dependem delas:
-- clientes_crm.telefone_norm, crm_entrada_falhas.telefone_norm e crm_conversas.exibicao.

CREATE OR REPLACE FUNCTION public.crm_telefone_digitos(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select regexp_replace(coalesce(p, ''), '\D', '', 'g');
$function$;

CREATE OR REPLACE FUNCTION public.crm_telefone_normalizado(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  with d as (select public.crm_telefone_digitos(p) as n)
  select case
    when n = '' then null
    when length(n) > 13 then null                                -- LID, nao e telefone
    when length(n) in (12, 13) and left(n, 2) = '55' then
      case when length(substr(n, 3)) = 10
           then substr(n, 3, 2) || '9' || substr(n, 5)           -- 55 + DDD + 8: poe o 9
           else substr(n, 3) end                                 -- 55 + DDD + 9 + 8
    when length(n) = 10 then left(n, 2) || '9' || substr(n, 3)   -- DDD + 8: poe o 9
    when length(n) = 11 then n                                   -- ja canonico
    else n end
  from d;
$function$;

CREATE OR REPLACE FUNCTION public.crm_mensagem_exibicao(p_mensagem text, p_tipo text, p_payload jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    -- Mensagem de verdade: passa direto.
    when coalesce(p_tipo, '') <> 'outro'
     and nullif(btrim(coalesce(p_mensagem, '')), '') is not null
     and p_mensagem !~* 'mensagem n[aã]o reconhecida'
      then p_mensagem
    -- Nao e mensagem: some da conversa.
    when p_payload->>'notification' in ('CHAT_LABEL_ASSOCIATION', 'PROFILE_NAME_UPDATED') then null
    when p_payload->'message'->>'type' = 'edit' then '[mensagem editada]'
    when p_payload->'message'->>'type' = 'revoke' or p_payload->>'notification' = 'REVOKE' then '[mensagem apagada]'
    when p_payload->>'notification' = 'CALL_RECEIVED' then '[chamada recebida]'
    when p_payload->>'notification' like 'CALL_MISSED%' then '[chamada perdida]'
    when nullif(btrim(coalesce(p_mensagem, '')), '') is null then '[mensagem não suportada]'
    when p_mensagem ~* 'mensagem n[aã]o reconhecida' then '[mensagem não suportada]'
    else p_mensagem
  end;
$function$;
