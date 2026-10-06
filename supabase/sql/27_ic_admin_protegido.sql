-- 27 O sistema nunca fica sem Admin.
--
-- 1. Ninguem altera o proprio perfil, papel ou status pelo app. Antes, um
--    Admin que trocava o proprio perfil por engano (ex.: para Atendente)
--    perdia o acesso na hora e nao conseguia desfazer: so outro Admin, ou SQL.
-- 2. Nenhuma alteracao ou exclusao pode deixar o sistema sem pelo menos um
--    Admin ativo.
--
-- Sem JWT (SQL Editor, migrations, jobs do banco) passa: e o caminho de
-- recuperacao. Edge Functions (service_role) seguem a regra 2.
--
-- Admin = perfil com is_admin, ou users.perfil = 'Admin' (mesma regra de
-- ic_eh_admin(), 14).
--
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

create or replace function public.ic_users_eh_admin_ativo(p_perfil_id uuid, p_perfil text, p_status text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_status, '') = 'ativo'
     and (coalesce(p_perfil, '') = 'Admin'
          or coalesce((select a.is_admin from public.perfis_acesso a where a.id = p_perfil_id), false));
$$;
comment on function public.ic_users_eh_admin_ativo(uuid, text, text) is 'IC: a combinacao perfil_id/perfil/status e de um Admin ativo? Usada pelo gatilho do 27.';
revoke execute on function public.ic_users_eh_admin_ativo(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ic_users_eh_admin_ativo(uuid, text, text) to service_role;

create or replace function public.ic_users_protege_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_era_admin boolean;
  v_fica_admin boolean;
  v_outros int;
begin
  if auth.jwt() is null then
    return coalesce(new, old);
  end if;

  -- 1. O proprio perfil, papel e status so outro Admin altera.
  if tg_op = 'UPDATE'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and lower(coalesce(old.email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
     and (new.perfil_id is distinct from old.perfil_id
          or new.perfil is distinct from old.perfil
          or new.role is distinct from old.role
          or new.status is distinct from old.status
          or new.email is distinct from old.email) then
    raise exception 'IC: voce nao pode alterar o proprio perfil ou status. Peca a outro Admin.'
      using errcode = '42501';
  end if;

  -- 2. Nunca zerar os Admins ativos.
  v_era_admin := public.ic_users_eh_admin_ativo(old.perfil_id, old.perfil, old.status);
  if tg_op = 'UPDATE' then
    v_fica_admin := public.ic_users_eh_admin_ativo(new.perfil_id, new.perfil, new.status);
  else
    v_fica_admin := false;
  end if;

  if v_era_admin and not v_fica_admin then
    select count(*) into v_outros
    from public.users u
    where u.id <> old.id
      and public.ic_users_eh_admin_ativo(u.perfil_id, u.perfil, u.status);
    if v_outros = 0 then
      raise exception 'IC: este e o ultimo Admin ativo. Promova outro usuario a Admin antes.'
        using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;
comment on function public.ic_users_protege_admin() is 'IC: ninguem altera o proprio perfil/status pelo app, e o sistema nunca fica sem Admin ativo.';
revoke execute on function public.ic_users_protege_admin() from public, anon, authenticated;

drop trigger if exists trg_ic_users_protege_admin on public.users;
create trigger trg_ic_users_protege_admin
  before update or delete on public.users
  for each row execute function public.ic_users_protege_admin();

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- drop trigger if exists trg_ic_users_protege_admin on public.users;
-- drop function if exists public.ic_users_protege_admin();
-- drop function if exists public.ic_users_eh_admin_ativo(uuid, text, text);
