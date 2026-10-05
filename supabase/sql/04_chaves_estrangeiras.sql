-- 04 Chaves estrangeiras
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- Ficaram de fora tres, que apontavam para fora do nucleo:
--   clientes_crm.pipeline_id -> pipelines        (tabela legada, nenhuma tela usa)
--   users.produto_principal_id -> score_produto_peso (camada de comissao)
--   vendas.curso_id -> cursos                    (a coluna nem veio no encaixe)
-- As colunas pipeline_id e produto_principal_id continuam, sem a chave.
alter table public.users add constraint users_perfil_id_fkey FOREIGN KEY (perfil_id) REFERENCES perfis_acesso(id) ON DELETE SET NULL;
alter table public.permissoes add constraint permissoes_perfil_id_fkey FOREIGN KEY (perfil_id) REFERENCES perfis_acesso(id) ON DELETE CASCADE;
alter table public.crm_funil_etapas add constraint crm_funil_etapas_funil_id_fkey FOREIGN KEY (funil_id) REFERENCES crm_funis(id) ON DELETE CASCADE;
alter table public.vendedores_whatsapp add constraint vendedores_whatsapp_funil_id_fkey FOREIGN KEY (funil_id) REFERENCES crm_funis(id);
alter table public.clientes_crm add constraint clientes_crm_mesclado_para_fkey FOREIGN KEY (mesclado_para) REFERENCES clientes_crm(id);
alter table public.crm_historico add constraint crm_historico_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES clientes_crm(id) ON DELETE CASCADE;
alter table public.crm_eventos_jornada add constraint crm_eventos_jornada_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES clientes_crm(id) ON DELETE CASCADE;
alter table public.crm_eventos_jornada add constraint crm_eventos_jornada_funil_id_fkey FOREIGN KEY (funil_id) REFERENCES crm_funis(id) ON DELETE SET NULL;
alter table public.crm_conversas add constraint crm_conversas_cliente_crm_id_fkey FOREIGN KEY (cliente_crm_id) REFERENCES clientes_crm(id);
alter table public.acoes_dia add constraint acoes_dia_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES clientes_crm(id) ON DELETE CASCADE;
alter table public.leads_distribuicao_log add constraint leads_distribuicao_log_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES clientes_crm(id) ON DELETE CASCADE;
