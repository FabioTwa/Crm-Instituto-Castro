-- 32 IA: a equipe encerra a conversa da assistente virtual.
--
-- ic_encerrar_conversa(card): botao "Encerrar conversa" do painel do lead.
--   - marca como atendidos os handoffs pendentes do card;
--   - grava em ia_decisoes_log uma linha etapa_pipeline='encerramento',
--     decisao='encerrada_pela_equipe'.
-- A proxima mensagem do lead abre conversa nova: a IA volta a atender (o
-- "vendedor respondeu nas ultimas 24 h" e o limite de respostas contam so
-- depois do encerramento). Nao envia nada ao lead.
--
-- So usuario ativo com o card no proprio escopo (ic_card_no_escopo).
-- Aditivo: so cria uma funcao. Idempotente. ROLLBACK no fim.

create or replace function public.ic_encerrar_conversa(p_cliente uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users;
  v_vendedor text;
  n integer := 0;
begin
  u := public.ic_usuario_atual();
  if u.id is null or coalesce(u.status, '') <> 'ativo' then
    raise exception 'nao_autorizado' using errcode = '42501';
  end if;
  select c.vendedor_id::text into v_vendedor
  from public.clientes_crm c
  where c.id = p_cliente and c.deleted_at is null;
  if not found or not public.ic_card_no_escopo(v_vendedor) then
    raise exception 'card_nao_encontrado' using errcode = 'P0002';
  end if;

  update public.ia_handoffs
  set atendido_em = now(),
      atendido_por = coalesce(u.name, u.email, 'desconhecido')
  where cliente_crm_id = p_cliente and atendido_em is null;
  get diagnostics n = row_count;

  insert into public.ia_decisoes_log (cliente_crm_id, etapa_pipeline, decisao, motivo, detalhe)
  values (p_cliente, 'encerramento', 'encerrada_pela_equipe', coalesce(u.name, u.email),
          jsonb_build_object('handoffs_atendidos', n));
  return n;
end;
$$;
comment on function public.ic_encerrar_conversa(uuid) is 'IC: a equipe encerra a conversa da IA com o lead (fecha handoffs pendentes e marca encerramento). A proxima mensagem do lead volta para a IA.';

revoke execute on function public.ic_encerrar_conversa(uuid) from public, anon;
grant execute on function public.ic_encerrar_conversa(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- drop function if exists public.ic_encerrar_conversa(uuid);
