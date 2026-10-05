-- 09 RLS e politicas
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- 
-- ATENCAO: neste arquivo quase toda politica do CRM e "using (true)" para
-- public, ou seja, quem tem a chave anon le e escreve o CRM inteiro. O
-- 15_ic_rls.sql derruba essas politicas e recria com escopo por perfil: rode o
-- 15 logo depois do 14, antes de abrir o sistema para qualquer pessoa.

alter table public.perfis_acesso enable row level security;
create policy "allow_all_perfis_acesso" on public.perfis_acesso as permissive for all to public
  using (true)
  with check (true);
alter table public.users enable row level security;
create policy "users_delete_restricted" on public.users as permissive for delete to public
  using ((auth.role() = 'service_role'::text));
create policy "users_insert_public" on public.users as permissive for insert to public
  with check (true);
create policy "users_select_public" on public.users as permissive for select to public
  using (true);
create policy "users_update_own" on public.users as permissive for update to public
  using (true);
alter table public.sistema_telas enable row level security;
create policy "sistema_telas_admin" on public.sistema_telas as permissive for all to authenticated
  using (true);
create policy "sistema_telas_read" on public.sistema_telas as permissive for select to authenticated
  using (true);
alter table public.permissoes enable row level security;
create policy "allow_all_permissoes" on public.permissoes as permissive for all to public
  using (true)
  with check (true);
alter table public.perfil_permissoes enable row level security;
create policy "allow_all_perfil_permissoes" on public.perfil_permissoes as permissive for all to public
  using (true)
  with check (true);
alter table public.audit_log enable row level security;
create policy "audit_insert_all" on public.audit_log as permissive for insert to public
  with check (true);
create policy "audit_no_delete" on public.audit_log as permissive for delete to public
  using (false);
create policy "audit_no_update" on public.audit_log as permissive for update to public
  using (false);
create policy "audit_select_authenticated" on public.audit_log as permissive for select to public
  using (((auth.role() = 'authenticated'::text) OR (auth.role() = 'service_role'::text)));
-- audit_log_critico, crm_funis, crm_funil_etapas: RLS desligada neste arquivo;
-- o 15_ic_rls.sql liga.
alter table public.vendedores_whatsapp enable row level security;
create policy "vendedores_whatsapp_all" on public.vendedores_whatsapp as permissive for all to public
  using (true)
  with check (true);
alter table public.clientes_crm enable row level security;
create policy "all_clientes_crm" on public.clientes_crm as permissive for all to public
  using (true)
  with check (true);
alter table public.crm_historico enable row level security;
create policy "all_crm_historico" on public.crm_historico as permissive for all to public
  using (true)
  with check (true);
alter table public.crm_eventos_jornada enable row level security;
create policy "eventos_jornada_delete_all" on public.crm_eventos_jornada as permissive for delete to public
  using (true);
create policy "eventos_jornada_insert_all" on public.crm_eventos_jornada as permissive for insert to public
  with check (true);
create policy "eventos_jornada_select_all" on public.crm_eventos_jornada as permissive for select to public
  using (true);
create policy "eventos_jornada_update_all" on public.crm_eventos_jornada as permissive for update to public
  using (true)
  with check (true);
alter table public.crm_conversas enable row level security;
create policy "crm_conversas_all" on public.crm_conversas as permissive for all to public
  using (true)
  with check (true);
alter table public.crm_conversas_repetidas enable row level security;
create policy "crm_conversas_repetidas_leitura" on public.crm_conversas_repetidas as permissive for select to authenticated
  using (true);
alter table public.crm_entrada_bruta enable row level security;
create policy "crm_entrada_bruta_leitura" on public.crm_entrada_bruta as permissive for select to authenticated
  using (true);
alter table public.crm_entrada_falhas enable row level security;
create policy "crm_entrada_falhas_leitura" on public.crm_entrada_falhas as permissive for select to authenticated
  using (true);
alter table public.crm_mescla_log enable row level security;
create policy "crm_mescla_log_leitura" on public.crm_mescla_log as permissive for select to authenticated, anon
  using (true);
alter table public.crm_mescla_retrato enable row level security;
create policy "crm_mescla_retrato_leitura" on public.crm_mescla_retrato as permissive for select to authenticated
  using (true);
alter table public.crm_numeros_internos enable row level security;
create policy "crm_numeros_internos_leitura" on public.crm_numeros_internos as permissive for select to authenticated, anon
  using (true);
alter table public.acoes_dia enable row level security;
create policy "acoes_dia_all" on public.acoes_dia as permissive for all to public
  using (true)
  with check (true);
alter table public.leads_distribuicao_log enable row level security;
create policy "leads_distribuicao_log_all" on public.leads_distribuicao_log as permissive for all to public
  using (true)
  with check (true);
alter table public.leads_diario enable row level security;
create policy "leads_diario_all_access" on public.leads_diario as permissive for all to public
  using (true)
  with check (true);
alter table public.mkt_gasto_campanha_dia enable row level security;
create policy "mkt_gasto_leitura" on public.mkt_gasto_campanha_dia as permissive for select to authenticated, anon
  using (true);
alter table public.jornada_metas enable row level security;
create policy "jornada_metas_all" on public.jornada_metas as permissive for all to public
  using (true)
  with check (true);
alter table public.crm_ia_config enable row level security;
create policy "crm_ia_config_leitura" on public.crm_ia_config as permissive for select to authenticated, anon
  using (true);
alter table public.crm_conversa_analise enable row level security;
create policy "crm_conversa_analise_leitura" on public.crm_conversa_analise as permissive for select to authenticated, anon
  using (true);
alter table public.vendas enable row level security;
create policy "all_vendas" on public.vendas as permissive for all to public
  using (true)
  with check (true);
