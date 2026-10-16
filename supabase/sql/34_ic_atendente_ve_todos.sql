-- 34 Atendente ve todos os leads.
--
-- Na clinica os atendentes sao responsaveis por todos os atendimentos. Antes,
-- o perfil Vendedor (Atendente) so via os cards em que era o vendedor_id, os
-- sem dono e os dos atendentes marcados em vendedores_responsaveis_ids. Como
-- o numero de WhatsApp fica ligado a um usuario, todo lead novo nascia com o
-- dono do numero e o atendente recem-criado entrava com o CRM vazio.
--
-- Agora qualquer usuario logado e cadastrado ve todos os cards (e as tabelas
-- filhas, que herdam por clientes_crm). Quem precisar de recorte continua
-- tendo o filtro de escopo do perfil (tela Permissoes, "Atendentes
-- permitidos" / "Funis permitidos").
--
-- Continua igual: escrita administrativa so Admin; anon nao le nada
-- (ic_usuario_atual devolve nulo sem JWT de usuario).
--
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

begin;

create or replace function public.ic_card_no_escopo(p_vendedor_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u public.users;
begin
  u := public.ic_usuario_atual();
  return u.id is not null;
end;
$$;
comment on function public.ic_card_no_escopo(text) is 'IC: o usuario atual pode ver um card deste vendedor_id? Qualquer usuario logado e cadastrado: sim (34). O recorte fica no escopo do perfil.';
grant execute on function public.ic_card_no_escopo(text) to anon, authenticated, service_role;

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK: rodar de novo a funcao ic_card_no_escopo do 15_ic_rls.sql
-- (Admin/Financeiro/SDR veem tudo; Vendedor so o proprio, sem dono ou os que
-- supervisiona).
