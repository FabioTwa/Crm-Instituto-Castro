-- Bootstrap do modo demonstração local (PGlite). Recria o mínimo do Supabase
-- que o Postgres puro não tem: papéis, schema auth, publicação realtime.
-- auth.jwt() lê o e-mail da sessão de teste de uma configuração de sessão.
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', nullif(current_setting('app.jwt_email', true), ''))
$$;
create publication supabase_realtime;
