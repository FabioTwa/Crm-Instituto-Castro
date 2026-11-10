-- 49 WhatsApp: quando OUTRO numero le o QR Code (ex.: troca do chip de teste
-- pelo numero oficial do Instituto), o cadastro do numero do CRM passa a ser o
-- que esta de fato conectado.
--
-- ic_whatsapp_registrar_estado ganha o parametro p_numero (o numero que a Z-API
-- informa ao conectar: aviso "Ao conectar" ou GET /device). Ao conectar com um
-- numero diferente, troca vendedores_whatsapp.numero_whatsapp e registra no
-- Historico de alteracoes (so os 4 ultimos digitos). Sem p_numero, nada muda.
--
-- Por que importa: a faixa e a tela mostram esse numero, e a retomada pos-queda
-- usa a lista de numeros do CRM para nunca chamar o proprio numero. As mensagens
-- ja chegavam pela instancia da Z-API (nao pelo numero), entao isto nao muda o
-- caminho das mensagens.
--
-- Antes: copia de vendedores_whatsapp em bkp_20261105.vendedores_whatsapp_49.
-- A funcao antiga (5 parametros) e trocada pela nova (6, o ultimo opcional):
-- quem chama sem p_numero continua funcionando. Idempotente. Tudo numa
-- transacao. ROLLBACK no fim.
--
-- COMO RODAR: Supabase > SQL Editor > New query > colar tudo > Run.

begin;

create table if not exists bkp_20261105.vendedores_whatsapp_49 as select * from public.vendedores_whatsapp;

drop function if exists public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz);

create or replace function public.ic_whatsapp_registrar_estado(
  p_linha_id    uuid,
  p_conectado   boolean,
  p_origem      text,
  p_usuario_id  uuid default null,
  p_queda_desde timestamptz default null,
  p_numero      text default null
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
  v_numero text := nullif(regexp_replace(coalesce(p_numero, ''), '\D', '', 'g'), '');
begin
  if p_origem not in ('zapi', 'consulta', 'tela') then
    raise exception 'origem invalida';
  end if;

  select * into v_linha from public.vendedores_whatsapp where id = p_linha_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'linha_nao_encontrada');
  end if;

  v_mudou := v_linha.zapi_estado is distinct from v_estado;

  -- Numero novo leu o QR Code (troca do chip de teste pelo oficial): o
  -- cadastro passa a ter o numero que esta de fato conectado. So ao conectar.
  if p_conectado and v_numero is not null and length(v_numero) between 10 and 15
     and v_numero is distinct from regexp_replace(coalesce(v_linha.numero_whatsapp, ''), '\D', '', 'g') then
    update public.vendedores_whatsapp set numero_whatsapp = v_numero, updated_at = v_agora where id = p_linha_id;
    insert into public.audit_log_critico (tabela, operacao, registro_id, user_id, dados_antes, dados_depois)
    values ('whatsapp', 'UPDATE', p_linha_id::text, p_usuario_id::text,
            jsonb_build_object('numero_final', right(regexp_replace(coalesce(v_linha.numero_whatsapp, ''), '\D', '', 'g'), 4)),
            jsonb_build_object('numero_final', right(v_numero, 4),
                               'nome', 'WhatsApp: número do CRM trocado (final ' || right(v_numero, 4) || ')'));
    v_linha.numero_whatsapp := v_numero;
  end if;

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
    'desde', (select zapi_estado_desde from public.vendedores_whatsapp where id = p_linha_id),
    'numero', v_linha.numero_whatsapp);
end;
$$;

revoke all on function public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz, text) to service_role;

commit;

-- Conferencia: deve terminar com ", p_numero text".
select pg_get_function_identity_arguments(oid) as parametros
  from pg_proc where proname = 'ic_whatsapp_registrar_estado';

-- ---------------------------------------------------------------------------
-- ROLLBACK: rodar de novo o bloco 3 e os grants da SQL 48 depois de
-- drop function if exists public.ic_whatsapp_registrar_estado(uuid, boolean, text, uuid, timestamptz, text);
-- e, se precisar voltar o numero:
-- update public.vendedores_whatsapp v set numero_whatsapp = b.numero_whatsapp
--   from bkp_20261105.vendedores_whatsapp_49 b where b.id = v.id;
