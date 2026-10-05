-- 25 Usuarios so pelo Supabase Auth.
--
-- 1. users.pw nunca guarda senha: o unico valor aceito e 'supabase_auth'. A
--    senha mora so no Supabase Auth (criada pela Edge Function ic-usuarios).
--    Linhas antigas com outro valor sao zeradas aqui: essas pessoas precisam
--    ter a conta criada no Auth (painel ou tela Novo Usuario).
-- 2. Quem nao e Admin so altera, na propria linha, nome, foto e iniciais.
--    Antes, a politica ic_users_update deixava a pessoa trocar o proprio
--    perfil, role, status e permissoes (virar Admin).
--
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

-- ---------------------------------------------------------------------------
-- 1. pw sem senha
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.users where pw is distinct from 'supabase_auth';
  if n > 0 then
    raise notice 'IC 25: % usuario(s) tinham senha em users.pw; zerados. Crie a conta deles no Supabase Auth.', n;
  end if;
end
$$;

update public.users set pw = 'supabase_auth' where pw is distinct from 'supabase_auth';
alter table public.users alter column pw set default 'supabase_auth';
alter table public.users alter column pw set not null;
alter table public.users drop constraint if exists users_pw_sem_senha;
alter table public.users add constraint users_pw_sem_senha check (pw = 'supabase_auth');

-- ---------------------------------------------------------------------------
-- 2. Campos que so Admin altera
-- ---------------------------------------------------------------------------
create or replace function public.ic_users_protege_campos()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v public.users;
begin
  -- service_role (Edge Functions) e Admin passam. Sem JWT (migrations, SQL
  -- Editor, jobs do banco) tambem.
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role'
     or auth.jwt() is null
     or public.ic_eh_admin() then
    return new;
  end if;

  v := new;
  v.name := old.name;
  v.photo_base64 := old.photo_base64;
  v.ini := old.ini;
  if v is distinct from old then
    raise exception 'IC: so Admin altera perfil, permissoes, status e responsaveis de um usuario'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
comment on function public.ic_users_protege_campos() is 'IC: quem nao e Admin so altera nome, foto e iniciais da propria linha em users.';

drop trigger if exists trg_ic_users_protege_campos on public.users;
create trigger trg_ic_users_protege_campos
  before update on public.users
  for each row execute function public.ic_users_protege_campos();

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- begin;
-- drop trigger if exists trg_ic_users_protege_campos on public.users;
-- drop function if exists public.ic_users_protege_campos();
-- alter table public.users drop constraint if exists users_pw_sem_senha;
-- alter table public.users alter column pw drop not null;
-- commit;
-- (as senhas zeradas no passo 1 nao voltam: a conta passa a existir so no Auth)
