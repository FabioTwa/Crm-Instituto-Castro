-- 08 Gatilhos
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- 
-- Os sete gatilhos do nucleo, como pg_get_triggerdef devolve.
--   auditoria (audit_log_critico), trava de DELETE fisico no card, trava de
--   mais de 50 exclusoes em 60 s, grafia unica de origem, carimbo data_venda
--   ("quando o card foi ganho"), data de entrada propagada para a jornada e
--   para leads_diario, e o referral do anuncio extraido da conversa.
-- Ficaram de fora os gatilhos de vendas, dados_preenchidos, pagamentos,
-- turmas, comissao e gamificacao: todos da camada de venda.

CREATE TRIGGER trg_audit_clientes_crm AFTER INSERT OR DELETE OR UPDATE ON public.clientes_crm FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
CREATE TRIGGER trg_bloquear_hard_delete BEFORE DELETE ON public.clientes_crm FOR EACH ROW EXECUTE FUNCTION bloquear_hard_delete_clientes();
CREATE TRIGGER trg_crm_origem_normalizar BEFORE INSERT OR UPDATE OF origem ON public.clientes_crm FOR EACH ROW EXECUTE FUNCTION fn_crm_origem_normalizar();
CREATE TRIGGER trg_marcar_data_venda BEFORE UPDATE ON public.clientes_crm FOR EACH ROW EXECUTE FUNCTION marcar_data_venda();
CREATE TRIGGER trg_proteger_delete_massa BEFORE UPDATE OF deleted_at ON public.clientes_crm FOR EACH ROW WHEN (((new.deleted_at IS NOT NULL) AND (old.deleted_at IS NULL))) EXECUTE FUNCTION proteger_delete_massa();
CREATE TRIGGER trg_sync_data_entrada AFTER UPDATE OF data_entrada ON public.clientes_crm FOR EACH ROW EXECUTE FUNCTION sync_data_entrada_propaga();
CREATE TRIGGER crm_conversas_extrai_referral AFTER INSERT ON public.crm_conversas FOR EACH ROW EXECUTE FUNCTION trg_crm_conversas_extrai_referral();
