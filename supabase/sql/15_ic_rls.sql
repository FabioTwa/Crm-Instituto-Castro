-- 15 IC: fecha a RLS aberta dos arquivos 00-12
-- IC CRM, camada sobre o esquema base (00-12). Depende de 13 e 14 (ic_usuario_atual,
-- ic_eh_admin, ic_perfil_nome, ic_feature_flags).
--
-- O 09 cria politicas "using (true)" para public: quem tem a chave
-- anon le e escreve o CRM inteiro. Este arquivo derruba essas politicas e
-- recria com a estrategia:
--   * anon nao le nada (excecao: insert em audit_log, porque o login falho
--     grava antes de autenticar);
--   * authenticated le o que a tela precisa; escreve cards, historico,
--     conversas, acoes, agendamentos;
--   * escritas administrativas (perfis, permissoes, telas, funis, numeros,
--     metas, flags, usuarios) so Admin (ic_eh_admin());
--   * service_role sempre passa: no Supabase ela tem BYPASSRLS. Nenhuma
--     politica aqui precisa cita-la.
--
-- FATO CRITICO: as funcoes base em 06 NAO sao security definer. Rodam com os
-- direitos de quem chama e estas politicas valem dentro delas. Por isso toda
-- tabela que uma funcao base le continua legivel para authenticated
-- (clientes_crm com escopo, crm_conversas, vendas, crm_funil_etapas,
-- crm_funis, acoes_dia, crm_conversa_analise, crm_ia_config, crm_numeros_internos,
-- mkt_gasto_campanha_dia, jornada_metas, users).
--
-- Escopo do card (clientes_crm SELECT): Admin, Financeiro e SDR veem tudo;
-- Vendedor ve vendedor_id = seu id, ou nulo, ou um dos
-- vendedores_responsaveis_ids. As tabelas filhas (conversas, historico,
-- jornada, acoes) herdam por exists em clientes_crm. Nao ha recursao: a
-- politica de clientes_crm nao consulta nenhuma dessas tabelas.
--
-- Views: as 4 views do 07 passam a security_invoker = on, para que a RLS da
-- tabela valha tambem por elas (por padrao a view roda como o dono e
-- vazaria o escopo).
--
-- AVISO: feche a RLS em HOMOLOGACAO antes de producao. Teste cada perfil.
-- Idempotente (drop policy if exists antes de cada create).

begin;

-- ---------------------------------------------------------------------------
-- 0. Helper de escopo do card. Security definer: le users/perfis por baixo
--    da RLS. Admin/Financeiro/SDR (e qualquer perfil com is_admin) veem tudo.
-- ---------------------------------------------------------------------------
create or replace function public.ic_card_no_escopo(p_vendedor_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u public.users;
  perfil text;
begin
  u := public.ic_usuario_atual();
  if u.id is null then
    return false;
  end if;
  perfil := public.ic_perfil_nome();
  if public.ic_eh_admin() or perfil in ('Admin', 'Financeiro', 'SDR') then
    return true;
  end if;
  -- Vendedor (Atendente) e qualquer outro perfil: so o proprio escopo.
  return p_vendedor_id is null
      or p_vendedor_id = u.id
      or p_vendedor_id = any (coalesce(u.vendedores_responsaveis_ids, '{}'::text[]));
end;
$$;
comment on function public.ic_card_no_escopo(text) is 'IC: o usuario atual pode ver um card deste vendedor_id? Admin/Financeiro/SDR: sempre. Vendedor: o proprio, nulo ou os que supervisiona.';
grant execute on function public.ic_card_no_escopo(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Cards e tabelas filhas
-- ---------------------------------------------------------------------------
drop policy if exists "all_clientes_crm" on public.clientes_crm;
drop policy if exists "ic_clientes_select" on public.clientes_crm;
drop policy if exists "ic_clientes_insert" on public.clientes_crm;
drop policy if exists "ic_clientes_update" on public.clientes_crm;
create policy "ic_clientes_select" on public.clientes_crm for select to authenticated
  using (public.ic_card_no_escopo(vendedor_id));
create policy "ic_clientes_insert" on public.clientes_crm for insert to authenticated
  with check (true);
create policy "ic_clientes_update" on public.clientes_crm for update to authenticated
  using (public.ic_card_no_escopo(vendedor_id))
  with check (true);
-- delete: sem politica = negado (alem do gatilho trg_bloquear_hard_delete).

drop policy if exists "all_crm_historico" on public.crm_historico;
drop policy if exists "ic_historico_select" on public.crm_historico;
drop policy if exists "ic_historico_insert" on public.crm_historico;
drop policy if exists "ic_historico_update" on public.crm_historico;
create policy "ic_historico_select" on public.crm_historico for select to authenticated
  using (cliente_id is null or exists (select 1 from public.clientes_crm c where c.id = cliente_id));
create policy "ic_historico_insert" on public.crm_historico for insert to authenticated
  with check (cliente_id is null or exists (select 1 from public.clientes_crm c where c.id = cliente_id));
create policy "ic_historico_update" on public.crm_historico for update to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_id));
-- delete negado: o front (crmExcluirCliente) tentava apagar o historico ao
-- excluir o card; com RLS o delete afeta 0 linhas sem erro e o historico fica.

drop policy if exists "eventos_jornada_delete_all" on public.crm_eventos_jornada;
drop policy if exists "eventos_jornada_insert_all" on public.crm_eventos_jornada;
drop policy if exists "eventos_jornada_select_all" on public.crm_eventos_jornada;
drop policy if exists "eventos_jornada_update_all" on public.crm_eventos_jornada;
drop policy if exists "ic_jornada_select" on public.crm_eventos_jornada;
drop policy if exists "ic_jornada_insert" on public.crm_eventos_jornada;
drop policy if exists "ic_jornada_update" on public.crm_eventos_jornada;
create policy "ic_jornada_select" on public.crm_eventos_jornada for select to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_id));
create policy "ic_jornada_insert" on public.crm_eventos_jornada for insert to authenticated
  with check (exists (select 1 from public.clientes_crm c where c.id = cliente_id));
create policy "ic_jornada_update" on public.crm_eventos_jornada for update to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_id));

drop policy if exists "crm_conversas_all" on public.crm_conversas;
drop policy if exists "ic_conversas_select" on public.crm_conversas;
drop policy if exists "ic_conversas_insert" on public.crm_conversas;
drop policy if exists "ic_conversas_update" on public.crm_conversas;
create policy "ic_conversas_select" on public.crm_conversas for select to authenticated
  using (cliente_crm_id is null or exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
create policy "ic_conversas_insert" on public.crm_conversas for insert to authenticated
  with check (cliente_crm_id is null or exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
create policy "ic_conversas_update" on public.crm_conversas for update to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));

drop policy if exists "acoes_dia_all" on public.acoes_dia;
drop policy if exists "ic_acoes_select" on public.acoes_dia;
drop policy if exists "ic_acoes_insert" on public.acoes_dia;
drop policy if exists "ic_acoes_update" on public.acoes_dia;
create policy "ic_acoes_select" on public.acoes_dia for select to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_id));
create policy "ic_acoes_insert" on public.acoes_dia for insert to authenticated
  with check (exists (select 1 from public.clientes_crm c where c.id = cliente_id));
create policy "ic_acoes_update" on public.acoes_dia for update to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_id));

drop policy if exists "leads_diario_all_access" on public.leads_diario;
drop policy if exists "ic_leads_diario_select" on public.leads_diario;
drop policy if exists "ic_leads_diario_insert" on public.leads_diario;
drop policy if exists "ic_leads_diario_update" on public.leads_diario;
create policy "ic_leads_diario_select" on public.leads_diario for select to authenticated using (true);
create policy "ic_leads_diario_insert" on public.leads_diario for insert to authenticated with check (true);
create policy "ic_leads_diario_update" on public.leads_diario for update to authenticated using (true);

-- vendas: 14 funcoes base perguntam "este card foi ganho" aqui (invoker).
drop policy if exists "all_vendas" on public.vendas;
drop policy if exists "ic_vendas_select" on public.vendas;
drop policy if exists "ic_vendas_insert" on public.vendas;
drop policy if exists "ic_vendas_update" on public.vendas;
create policy "ic_vendas_select" on public.vendas for select to authenticated using (true);
create policy "ic_vendas_insert" on public.vendas for insert to authenticated with check (true);
create policy "ic_vendas_update" on public.vendas for update to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. Usuarios. Select para todos os logados (as telas listam responsaveis).
--    Insert/delete so Admin. Update: Admin, ou a propria linha. RLS nao
--    restringe COLUNAS: o front, no Meu Perfil, so envia name e photo_base64;
--    perfil/perfil_id/status so pela tela de Usuarios (Admin).
-- ---------------------------------------------------------------------------
drop policy if exists "users_delete_restricted" on public.users;
drop policy if exists "users_insert_public" on public.users;
drop policy if exists "users_select_public" on public.users;
drop policy if exists "users_update_own" on public.users;
drop policy if exists "ic_users_select" on public.users;
drop policy if exists "ic_users_insert" on public.users;
drop policy if exists "ic_users_update" on public.users;
drop policy if exists "ic_users_delete" on public.users;
create policy "ic_users_select" on public.users for select to authenticated using (true);
create policy "ic_users_insert" on public.users for insert to authenticated with check (public.ic_eh_admin());
create policy "ic_users_update" on public.users for update to authenticated
  using (public.ic_eh_admin() or lower(email) = lower(auth.jwt() ->> 'email'))
  with check (public.ic_eh_admin() or lower(email) = lower(auth.jwt() ->> 'email'));
create policy "ic_users_delete" on public.users for delete to authenticated using (public.ic_eh_admin());

-- ---------------------------------------------------------------------------
-- 3. Catalogos: select para logados, escrita so Admin.
-- ---------------------------------------------------------------------------
drop policy if exists "allow_all_perfis_acesso" on public.perfis_acesso;
drop policy if exists "ic_perfis_select" on public.perfis_acesso;
drop policy if exists "ic_perfis_admin" on public.perfis_acesso;
create policy "ic_perfis_select" on public.perfis_acesso for select to authenticated using (true);
create policy "ic_perfis_admin" on public.perfis_acesso for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

drop policy if exists "allow_all_permissoes" on public.permissoes;
drop policy if exists "ic_permissoes_select" on public.permissoes;
drop policy if exists "ic_permissoes_admin" on public.permissoes;
create policy "ic_permissoes_select" on public.permissoes for select to authenticated using (true);
create policy "ic_permissoes_admin" on public.permissoes for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

drop policy if exists "allow_all_perfil_permissoes" on public.perfil_permissoes;
drop policy if exists "ic_perfil_permissoes_select" on public.perfil_permissoes;
drop policy if exists "ic_perfil_permissoes_admin" on public.perfil_permissoes;
create policy "ic_perfil_permissoes_select" on public.perfil_permissoes for select to authenticated using (true);
create policy "ic_perfil_permissoes_admin" on public.perfil_permissoes for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

drop policy if exists "sistema_telas_admin" on public.sistema_telas;
drop policy if exists "sistema_telas_read" on public.sistema_telas;
drop policy if exists "ic_telas_select" on public.sistema_telas;
drop policy if exists "ic_telas_admin" on public.sistema_telas;
create policy "ic_telas_select" on public.sistema_telas for select to authenticated using (true);
create policy "ic_telas_admin" on public.sistema_telas for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

alter table public.crm_funis enable row level security;
drop policy if exists "ic_funis_select" on public.crm_funis;
drop policy if exists "ic_funis_admin" on public.crm_funis;
create policy "ic_funis_select" on public.crm_funis for select to authenticated using (true);
create policy "ic_funis_admin" on public.crm_funis for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

alter table public.crm_funil_etapas enable row level security;
drop policy if exists "ic_etapas_select" on public.crm_funil_etapas;
drop policy if exists "ic_etapas_admin" on public.crm_funil_etapas;
create policy "ic_etapas_select" on public.crm_funil_etapas for select to authenticated using (true);
create policy "ic_etapas_admin" on public.crm_funil_etapas for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

-- vendedores_whatsapp guarda zapi_token (coluna legada): select SO Admin.
-- O webhook e o envio usam service_role.
drop policy if exists "vendedores_whatsapp_all" on public.vendedores_whatsapp;
drop policy if exists "ic_vw_admin" on public.vendedores_whatsapp;
create policy "ic_vw_admin" on public.vendedores_whatsapp for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

drop policy if exists "jornada_metas_all" on public.jornada_metas;
drop policy if exists "ic_metas_select" on public.jornada_metas;
drop policy if exists "ic_metas_admin" on public.jornada_metas;
create policy "ic_metas_select" on public.jornada_metas for select to authenticated using (true);
create policy "ic_metas_admin" on public.jornada_metas for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

drop policy if exists "crm_ia_config_leitura" on public.crm_ia_config;
drop policy if exists "ic_ia_config_select" on public.crm_ia_config;
drop policy if exists "ic_ia_config_admin" on public.crm_ia_config;
create policy "ic_ia_config_select" on public.crm_ia_config for select to authenticated using (true);
create policy "ic_ia_config_admin" on public.crm_ia_config for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

alter table public.ic_feature_flags enable row level security;
drop policy if exists "ic_flags_select" on public.ic_feature_flags;
drop policy if exists "ic_flags_admin" on public.ic_feature_flags;
create policy "ic_flags_select" on public.ic_feature_flags for select to authenticated using (true);
create policy "ic_flags_admin" on public.ic_feature_flags for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

drop policy if exists "mkt_gasto_leitura" on public.mkt_gasto_campanha_dia;
drop policy if exists "ic_mkt_gasto_select" on public.mkt_gasto_campanha_dia;
drop policy if exists "ic_mkt_gasto_admin" on public.mkt_gasto_campanha_dia;
create policy "ic_mkt_gasto_select" on public.mkt_gasto_campanha_dia for select to authenticated using (true);
create policy "ic_mkt_gasto_admin" on public.mkt_gasto_campanha_dia for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

-- crm_numeros_internos: o esquema base (crm_numero_da_casa, invoker) le dentro de
-- crm_acoes_dia e do webhook. Fica legivel para logados; escrita Admin.
-- (Desvio consciente do "select admin": sem leitura, a tela Acoes do Dia
--  mostraria os numeros da casa como leads para quem nao e Admin.)
drop policy if exists "crm_numeros_internos_leitura" on public.crm_numeros_internos;
drop policy if exists "ic_numeros_internos_select" on public.crm_numeros_internos;
drop policy if exists "ic_numeros_internos_admin" on public.crm_numeros_internos;
create policy "ic_numeros_internos_select" on public.crm_numeros_internos for select to authenticated using (true);
create policy "ic_numeros_internos_admin" on public.crm_numeros_internos for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

-- crm_conversa_analise: crm_acoes_dia (invoker) le a ultima analise de cada
-- card. Fica legivel para logados, com o escopo do card. Escrita: service_role.
drop policy if exists "crm_conversa_analise_leitura" on public.crm_conversa_analise;
drop policy if exists "ic_conversa_analise_select" on public.crm_conversa_analise;
create policy "ic_conversa_analise_select" on public.crm_conversa_analise for select to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));

-- ---------------------------------------------------------------------------
-- 4. Auditoria e logs
-- ---------------------------------------------------------------------------
-- audit_log: insert para public fica (login falho grava antes de autenticar;
-- politicas audit_no_update/audit_no_delete base ficam). Select: Admin.
drop policy if exists "audit_select_authenticated" on public.audit_log;
drop policy if exists "ic_audit_select" on public.audit_log;
create policy "ic_audit_select" on public.audit_log for select to authenticated using (public.ic_eh_admin());

-- audit_log_critico: o gatilho audit_trigger_func roda como invoker, logo
-- authenticated precisa inserir. Select Admin ou Financeiro. Update/delete:
-- sem politica = negado.
alter table public.audit_log_critico enable row level security;
drop policy if exists "ic_audit_critico_insert" on public.audit_log_critico;
drop policy if exists "ic_audit_critico_select" on public.audit_log_critico;
create policy "ic_audit_critico_insert" on public.audit_log_critico for insert to authenticated with check (true);
create policy "ic_audit_critico_select" on public.audit_log_critico for select to authenticated
  using (public.ic_eh_admin() or public.ic_perfil_nome() = 'Financeiro');

drop policy if exists "leads_distribuicao_log_all" on public.leads_distribuicao_log;
drop policy if exists "ic_distribuicao_insert" on public.leads_distribuicao_log;
drop policy if exists "ic_distribuicao_select" on public.leads_distribuicao_log;
create policy "ic_distribuicao_insert" on public.leads_distribuicao_log for insert to authenticated with check (true);
create policy "ic_distribuicao_select" on public.leads_distribuicao_log for select to authenticated using (public.ic_eh_admin());

-- Tabelas tecnicas (porta de entrada, mescla): select Admin.
drop policy if exists "crm_entrada_bruta_leitura" on public.crm_entrada_bruta;
drop policy if exists "ic_entrada_bruta_select" on public.crm_entrada_bruta;
create policy "ic_entrada_bruta_select" on public.crm_entrada_bruta for select to authenticated using (public.ic_eh_admin());

drop policy if exists "crm_entrada_falhas_leitura" on public.crm_entrada_falhas;
drop policy if exists "ic_entrada_falhas_select" on public.crm_entrada_falhas;
create policy "ic_entrada_falhas_select" on public.crm_entrada_falhas for select to authenticated using (public.ic_eh_admin());

drop policy if exists "crm_conversas_repetidas_leitura" on public.crm_conversas_repetidas;
drop policy if exists "ic_conversas_repetidas_select" on public.crm_conversas_repetidas;
create policy "ic_conversas_repetidas_select" on public.crm_conversas_repetidas for select to authenticated using (public.ic_eh_admin());

drop policy if exists "crm_mescla_log_leitura" on public.crm_mescla_log;
drop policy if exists "ic_mescla_log_select" on public.crm_mescla_log;
create policy "ic_mescla_log_select" on public.crm_mescla_log for select to authenticated using (public.ic_eh_admin());

drop policy if exists "crm_mescla_retrato_leitura" on public.crm_mescla_retrato;
drop policy if exists "ic_mescla_retrato_select" on public.crm_mescla_retrato;
create policy "ic_mescla_retrato_select" on public.crm_mescla_retrato for select to authenticated using (public.ic_eh_admin());

-- ---------------------------------------------------------------------------
-- 5. Views do 07 respeitam a RLS de quem chama.
-- ---------------------------------------------------------------------------
alter view public.crm_analise_leads_base set (security_invoker = on);
alter view public.crm_duplicados_grupos set (security_invoker = on);
alter view public.crm_leads_cpl_base set (security_invoker = on);
alter view public.vw_crm_entrada_parada set (security_invoker = on);

commit;

-- VERIFICACAO:
-- -- Nenhuma politica "aberta" para public deve sobrar, salvo audit_log insert/no_update/no_delete:
-- select tablename, policyname, roles, cmd, qual
-- from pg_policies where schemaname = 'public' and roles = '{public}' order by 1, 2;
-- -- Toda tabela do public com RLS ligada:
-- select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and relkind = 'r' order by relrowsecurity, relname;
-- -- Politicas por tabela:
-- select tablename, count(*) from pg_policies where schemaname = 'public' group by 1 order by 1;
-- -- Views com security_invoker:
-- select relname, reloptions from pg_class where relkind = 'v' and relnamespace = 'public'::regnamespace;

-- ROLLBACK (volta ao estado do 09; as politicas ic_* caem e as originais voltam):
-- begin;
-- drop policy if exists "ic_clientes_select" on public.clientes_crm; drop policy if exists "ic_clientes_insert" on public.clientes_crm; drop policy if exists "ic_clientes_update" on public.clientes_crm;
-- create policy "all_clientes_crm" on public.clientes_crm for all to public using (true) with check (true);
-- -- ... repetir para cada tabela: drop das ic_* e create da politica original listada em 09_rls_e_politicas.sql.
-- alter table public.crm_funis disable row level security;
-- alter table public.crm_funil_etapas disable row level security;
-- alter table public.audit_log_critico disable row level security;
-- alter view public.crm_analise_leads_base reset (security_invoker);
-- alter view public.crm_duplicados_grupos reset (security_invoker);
-- alter view public.crm_leads_cpl_base reset (security_invoker);
-- alter view public.vw_crm_entrada_parada reset (security_invoker);
-- drop function if exists public.ic_card_no_escopo(text);
-- commit;
-- Atalho: rodar de novo o 09_rls_e_politicas.sql depois dos drops das ic_*.
