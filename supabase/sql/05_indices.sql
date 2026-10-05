-- 05 Indices
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- Dois indices unicos parciais carregam um MARCO de data no predicado
-- (crm_card_unico_por_funil e crm_conversa_unica_por_instancia): o indice so
-- vale para registros posteriores a ele. Numa base vazia todo registro e
-- posterior ao marco, entao ele nao atrapalha; pode ser removido do predicado
-- se quiser. NAO troque o webhook
-- para "on conflict": ele captura o 23505 de proposito (ver comentario no
-- index.ts).
CREATE INDEX idx_perfis_is_admin ON public.perfis_acesso USING btree (is_admin);
CREATE INDEX idx_perfis_ativo ON public.perfis_acesso USING btree (ativo);
CREATE INDEX idx_users_fixo ON public.users USING btree (fixo_mensal) WHERE (fixo_mensal > (0)::numeric);
CREATE INDEX idx_users_perfil_id ON public.users USING btree (perfil_id);
CREATE INDEX idx_users_vendedores_resp_gin ON public.users USING gin (vendedores_responsaveis_ids);
CREATE INDEX idx_permissoes_perfil ON public.permissoes USING btree (perfil_id);
CREATE INDEX idx_permissoes_tela ON public.permissoes USING btree (tela_chave);
CREATE INDEX idx_permissoes_escopos_gin ON public.permissoes USING gin (escopos);
CREATE INDEX idx_audit_tabela_data ON public.audit_log_critico USING btree (tabela, alterado_em DESC);
CREATE INDEX idx_audit_user ON public.audit_log_critico USING btree (user_id);
CREATE INDEX idx_audit_registro ON public.audit_log_critico USING btree (registro_id);
CREATE INDEX idx_vendedores_whatsapp_vendedor_id ON public.vendedores_whatsapp USING btree (vendedor_id);
CREATE INDEX idx_vendedores_whatsapp_funil_id ON public.vendedores_whatsapp USING btree (funil_id);
CREATE INDEX idx_vendedores_whatsapp_numero ON public.vendedores_whatsapp USING btree (numero_whatsapp);
CREATE INDEX idx_vendedores_whatsapp_meta_phone_id ON public.vendedores_whatsapp USING btree (meta_phone_id);
CREATE INDEX idx_clientes_crm_nome_trgm ON public.clientes_crm USING gin (nome gin_trgm_ops);
CREATE INDEX idx_clientes_crm_chat_lid ON public.clientes_crm USING btree (chat_lid) WHERE (chat_lid IS NOT NULL);
CREATE UNIQUE INDEX crm_card_unico_por_funil ON public.clientes_crm USING btree (telefone_norm, funil_id) WHERE ((deleted_at IS NULL) AND (mesclado_para IS NULL) AND (telefone_norm IS NOT NULL) AND (funil_id IS NOT NULL) AND (created_at >= '2026-09-24 18:52:00+00'::timestamp with time zone));
CREATE INDEX idx_clientes_crm_ativos ON public.clientes_crm USING btree (funil_id, etapa) WHERE (deleted_at IS NULL);
CREATE INDEX idx_clientes_crm_ordem_espera ON public.clientes_crm USING btree (ordem_espera) WHERE ((deleted_at IS NULL) AND (ordem_espera IS NOT NULL));
CREATE INDEX idx_clientes_crm_google_campanha ON public.clientes_crm USING btree (google_campanha_id) WHERE (google_campanha_id IS NOT NULL);
CREATE INDEX idx_clientes_crm_sla_status ON public.clientes_crm USING btree (sla_status);
CREATE INDEX idx_clientes_crm_data_venda ON public.clientes_crm USING btree (data_venda) WHERE (data_venda IS NOT NULL);
CREATE INDEX idx_clientes_crm_mesclado ON public.clientes_crm USING btree (mesclado_para) WHERE (mesclado_para IS NOT NULL);
CREATE INDEX idx_clientes_crm_telefone_norm ON public.clientes_crm USING btree (telefone_norm, data_entrada, id) WHERE ((deleted_at IS NULL) AND (telefone_norm IS NOT NULL));
CREATE INDEX idx_clientes_crm_data_entrada_ativos ON public.clientes_crm USING btree (data_entrada) WHERE (deleted_at IS NULL);
CREATE INDEX idx_clientes_crm_numero_whatsapp ON public.clientes_crm USING btree (numero_whatsapp) WHERE (numero_whatsapp IS NOT NULL);
CREATE INDEX idx_clientes_crm_whatsapp_digitos_trgm ON public.clientes_crm USING gin (regexp_replace(COALESCE(numero_whatsapp, ''::text), '[^0-9]'::text, ''::text, 'g'::text) gin_trgm_ops);
CREATE INDEX idx_clientes_crm_anuncio_id ON public.clientes_crm USING btree (anuncio_id) WHERE (anuncio_id IS NOT NULL);
CREATE INDEX idx_clientes_crm_telefone_digitos_trgm ON public.clientes_crm USING gin (regexp_replace(COALESCE(telefone, ''::text), '[^0-9]'::text, ''::text, 'g'::text) gin_trgm_ops);
CREATE INDEX idx_clientes_crm_lead_score ON public.clientes_crm USING btree (lead_score);
CREATE INDEX idx_clientes_crm_vendedor_whatsapp ON public.clientes_crm USING btree (vendedor_id, numero_whatsapp);
CREATE INDEX idx_clientes_crm_deleted ON public.clientes_crm USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);
CREATE INDEX idx_eventos_tipo ON public.crm_eventos_jornada USING btree (tipo_evento);
CREATE INDEX idx_eventos_created ON public.crm_eventos_jornada USING btree (created_at);
CREATE INDEX idx_eventos_metadata_gin ON public.crm_eventos_jornada USING gin (metadata);
CREATE INDEX idx_eventos_cliente_tipo ON public.crm_eventos_jornada USING btree (cliente_id, tipo_evento);
CREATE INDEX idx_eventos_funil ON public.crm_eventos_jornada USING btree (funil_id);
CREATE INDEX idx_eventos_deleted ON public.crm_eventos_jornada USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);
CREATE INDEX idx_eventos_vendedor ON public.crm_eventos_jornada USING btree (vendedor_id);
CREATE INDEX idx_eventos_cliente ON public.crm_eventos_jornada USING btree (cliente_id);
CREATE INDEX idx_crm_conversas_numero_lead ON public.crm_conversas USING btree (numero_lead);
CREATE INDEX idx_crm_conversas_mensagem_trgm ON public.crm_conversas USING gin (mensagem gin_trgm_ops);
CREATE UNIQUE INDEX crm_conversa_unica_por_instancia ON public.crm_conversas USING btree (zapi_message_id, vendedor_id) WHERE ((zapi_message_id IS NOT NULL) AND (criada_em >= '2026-09-24 20:51:42.042+00'::timestamp with time zone));
CREATE INDEX idx_crm_conversas_cliente ON public.crm_conversas USING btree (cliente_crm_id);
CREATE INDEX idx_crm_conversas_criada_em ON public.crm_conversas USING btree (criada_em);
CREATE INDEX idx_crm_conversas_vendedor_criada ON public.crm_conversas USING btree (vendedor_id, criada_em DESC);
CREATE INDEX idx_crm_conversas_repetidas_created_at ON public.crm_conversas_repetidas USING btree (created_at DESC);
CREATE INDEX crm_entrada_bruta_parada_idx ON public.crm_entrada_bruta USING btree (estado, chegou_em) WHERE (estado <> 'processada'::text);
CREATE INDEX idx_crm_entrada_falhas_created_at ON public.crm_entrada_falhas USING btree (created_at DESC);
CREATE INDEX idx_crm_entrada_falhas_telefone_norm ON public.crm_entrada_falhas USING btree (telefone_norm) WHERE (telefone_norm IS NOT NULL);
CREATE INDEX idx_crm_mescla_log_sobrevivente ON public.crm_mescla_log USING btree (sobrevivente);
CREATE INDEX idx_crm_mescla_log_absorvido ON public.crm_mescla_log USING btree (absorvido);
CREATE INDEX crm_mescla_retrato_sobrevivente_idx ON public.crm_mescla_retrato USING btree (sobrevivente, criado_em);
CREATE INDEX idx_acoes_vendedor_data ON public.acoes_dia USING btree (vendedor_id, data_prevista) WHERE (concluida = false);
CREATE INDEX idx_acoes_dia_adiar ON public.acoes_dia USING btree (cliente_id, data_prevista) WHERE ((tipo = 'adiar'::text) AND (concluida = false));
CREATE INDEX idx_acoes_cliente ON public.acoes_dia USING btree (cliente_id);
CREATE INDEX idx_distribuicao_log_cliente ON public.leads_distribuicao_log USING btree (cliente_id);
CREATE INDEX idx_distribuicao_log_vendedor ON public.leads_distribuicao_log USING btree (vendedor_novo_id);
CREATE INDEX idx_leads_diario_vendedor ON public.leads_diario USING btree (vendedor_id);
CREATE INDEX idx_leads_diario_crm ON public.leads_diario USING btree (crm_cliente_id);
CREATE INDEX idx_leads_diario_data ON public.leads_diario USING btree (data DESC);
CREATE INDEX idx_leads_diario_status ON public.leads_diario USING btree (status);
CREATE INDEX idx_mkt_gasto_campanha_dia ON public.mkt_gasto_campanha_dia USING btree (campanha_id, dia);
CREATE INDEX idx_mkt_gasto_anuncio_dia ON public.mkt_gasto_campanha_dia USING btree (anuncio_id, dia);
CREATE INDEX idx_crm_conversa_analise_cliente ON public.crm_conversa_analise USING btree (cliente_crm_id, analisada_em DESC);
CREATE INDEX idx_crm_conversa_analise_dia ON public.crm_conversa_analise USING btree (analisada_em);
