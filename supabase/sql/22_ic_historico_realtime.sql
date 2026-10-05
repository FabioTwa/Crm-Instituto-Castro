-- 22_ic_historico_realtime.sql
-- Anotações de outro usuário aparecem sem recarregar: publica crm_historico no Realtime.
-- Idempotente. A RLS continua valendo: o Realtime só entrega linhas que o usuário pode ler.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crm_historico') then
    alter publication supabase_realtime add table public.crm_historico;
  end if;
end $$;

-- ROLLBACK:
-- do $$ begin if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='crm_historico')
--   then alter publication supabase_realtime drop table public.crm_historico; end if; end $$;
