-- 59 Funcoes de permissao fora do alcance de quem nao fez login.
--
-- O 26 deixou ic_usuario_atual, ic_eh_admin, ic_perfil_nome e
-- ic_card_no_escopo com anon porque as politicas de RLS chamam essas funcoes.
-- Conferido em 26/11/2026: nenhuma politica, view ou tela do front usa essas
-- funcoes para a role anon (todas as politicas sao de authenticated). Elas
-- seguem liberadas para authenticated e service_role, entao o CRM logado e as
-- Edge Functions continuam iguais.
--
-- rls_auto_enable e a funcao do gatilho de evento ensure_rls (liga RLS em
-- toda tabela nova). Gatilho de evento nao confere EXECUTE de quem roda o DDL,
-- entao ela sai da API para anon e authenticated sem deixar de funcionar.
--
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

begin;

revoke execute on function public.ic_usuario_atual() from public, anon;
revoke execute on function public.ic_eh_admin() from public, anon;
revoke execute on function public.ic_perfil_nome() from public, anon;
revoke execute on function public.ic_card_no_escopo(text) from public, anon;

grant execute on function public.ic_usuario_atual() to authenticated, service_role;
grant execute on function public.ic_eh_admin() to authenticated, service_role;
grant execute on function public.ic_perfil_nome() to authenticated, service_role;
grant execute on function public.ic_card_no_escopo(text) to authenticated, service_role;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
grant execute on function public.rls_auto_enable() to service_role;

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- grant execute on function public.ic_usuario_atual() to anon;
-- grant execute on function public.ic_eh_admin() to anon;
-- grant execute on function public.ic_perfil_nome() to anon;
-- grant execute on function public.ic_card_no_escopo(text) to anon;
-- grant execute on function public.rls_auto_enable() to anon, authenticated;
