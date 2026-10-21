-- Apagar os dados de teste do CRM (SO HOMOLOGACAO, enquanto o IC nao entra no ar).
--
-- Apaga tudo o que os testes geram: leads (cards), conversas, agendamentos,
-- vendas, handoffs, consentimentos, log da IA, historico, acoes do dia,
-- leads do dia e entradas brutas do webhook. Solta a trava ia_vez.
--
-- Mantem: usuarios e permissoes, funis e etapas, numeros de WhatsApp
-- (vendedores_whatsapp), crm_ia_config, exemplos da IA, flags, metas,
-- numeros internos, credenciais do Google, gasto de marketing e audit_log.
--
-- Trava de seguranca: para sem apagar nada se houver mais de 500 leads
-- (a homologacao tem poucos; um banco com muitos e provavelmente producao).
-- ⚠️ Nao tem volta. Remover este arquivo quando o IC entrar em producao.

begin;

do $$
declare
  n bigint;
begin
  select count(*) into n from public.clientes_crm;
  if n > 500 then
    raise exception 'apagar-dados-de-teste: % leads na base. Parece producao; nada foi apagado.', n;
  end if;
end;
$$;

delete from public.agendamentos;
delete from public.vendas;
delete from public.crm_conversa_analise;
delete from public.crm_conversas_repetidas;
delete from public.crm_conversas;
delete from public.ia_consentimentos;
delete from public.ia_handoffs;
delete from public.ia_decisoes_log;
delete from public.ic_cadastro_pendencias;
delete from public.leads_diario;
delete from public.crm_entrada_bruta;
delete from public.crm_entrada_falhas;
delete from public.crm_mescla_log;
delete from public.crm_mescla_retrato;
-- crm_historico, crm_eventos_jornada, acoes_dia e leads_distribuicao_log
-- saem junto (on delete cascade).
delete from public.clientes_crm;
update public.ia_vez set dono = null, ate = null where id = 1;

commit;
