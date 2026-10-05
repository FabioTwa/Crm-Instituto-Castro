-- 26 Funcoes SECURITY DEFINER fora do alcance de quem nao fez login.
--
-- crm_cards_irmaos e crm_mescla_resumo rodam como dono (ignoram RLS) e
-- devolviam nome e etapa de cards para a role anon, via /rest/v1/rpc, so com a
-- chave publica do front. Agora so authenticated e service_role executam.
--
-- ic_agendamento_confirmado e funcao de gatilho: o gatilho continua disparando
-- (EXECUTE so e conferido ao criar o gatilho), mas ela sai da API.
--
-- Ficam com anon de proposito (14 e 15): ic_usuario_atual, ic_eh_admin,
-- ic_perfil_nome e ic_card_no_escopo. As politicas de RLS chamam essas
-- funcoes, e sem JWT de usuario elas so devolvem nulo/false.
--
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

begin;

revoke execute on function public.crm_cards_irmaos(uuid) from public, anon;
revoke execute on function public.crm_mescla_resumo(uuid) from public, anon;
grant execute on function public.crm_cards_irmaos(uuid) to authenticated, service_role;
grant execute on function public.crm_mescla_resumo(uuid) to authenticated, service_role;

revoke execute on function public.ic_agendamento_confirmado() from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- grant execute on function public.crm_cards_irmaos(uuid) to public;
-- grant execute on function public.crm_mescla_resumo(uuid) to public;
-- grant execute on function public.ic_agendamento_confirmado() to public;
