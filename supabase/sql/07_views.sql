-- 07 Views
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- crm_analise_leads_base: base da secao Origem da tela de Leads.
-- crm_duplicados_grupos: grupos de cards da mesma pessoa no mesmo funil (mescla).
-- crm_leads_cpl_base: base do custo por lead.
-- vw_crm_entrada_parada: envelopes do webhook que o varredor ainda nao processou.

create view public.crm_analise_leads_base as
 WITH valid AS (
         SELECT c.id,
            c.created_at,
            c.updated_at,
            c.nome,
            c.telefone,
            c.email,
            c.cpf,
            c.profissao,
            c.origem,
            c.observacoes,
            c.etapa,
            c.vendedor_id,
            c.vendedor_nome,
            c.data_entrada,
            c.importado_de,
            c.pipeline_id,
            c.valor,
            c.valor_pago,
            c.contrato_status,
            c.forma_pagamento,
            c.pgto_conciliado,
            c.parcelas,
            c.valor_parcela,
            c.motivo_perda,
            c.funil_id,
            c.lead_score,
            c.lead_score_atualizado_em,
            c.fonte_lead,
            c.sla_status,
            c.deleted_at,
            c.deleted_by_user_id,
            c.delete_reason,
            c.campanha_origem,
            c.numero_whatsapp,
            c.lead_chegou_em,
            c.primeira_resposta_em,
            c.ultima_mensagem_em,
            c.ultima_mensagem_direcao,
            c.chat_lid,
            c.ctwa_token,
            c.campanha_nome,
            c.anuncio_id,
            c.anuncio_titulo,
            c.anuncio_texto,
            c.anuncio_link,
            c.anuncio_app,
            c.data_venda
           FROM clientes_crm c
          WHERE c.deleted_at IS NULL AND length(regexp_replace(COALESCE(c.telefone, ''::text), '[^0-9]'::text, ''::text, 'g'::text)) <= 13
        ), primeira AS (
         SELECT DISTINCT ON (crm_conversas.cliente_crm_id) crm_conversas.cliente_crm_id,
            crm_conversas.mensagem,
            crm_conversas.payload_raw,
            crm_conversas.criada_em
           FROM crm_conversas
          WHERE crm_conversas.autor = 'lead'::text AND crm_conversas.cliente_crm_id IS NOT NULL
          ORDER BY crm_conversas.cliente_crm_id, crm_conversas.criada_em
        ), venda_h AS (
         SELECT crm_historico.cliente_id,
            min(crm_historico.created_at) AS fechado_em
           FROM crm_historico
          WHERE crm_historico.etapa_nova = 'fechado'::text
          GROUP BY crm_historico.cliente_id
        )
 SELECT v.id AS cliente_id,
    v.vendedor_id,
    v.vendedor_nome,
    v.etapa,
    v.valor,
    v.valor_pago,
    v.contrato_status,
    v.campanha_nome,
    COALESCE(v.ctwa_token, crm_ctwa_token(p.payload_raw #> '{adContext,ctwaPayload}'::text[])) AS ctwa_token,
    p.criada_em AS primeiro_lead_em,
    vh.fechado_em AS venda_em,
    v.etapa = 'fechado'::text OR v.contrato_status = 'signed'::text OR COALESCE(v.valor_pago, 0::numeric) > 0::numeric AS virou_venda,
    (v.etapa = ANY (ARRAY['negociacao_quente'::text, 'pagamentocontrato_pendente'::text, 'visita'::text, 'fechado'::text])) OR v.contrato_status = 'signed'::text OR COALESCE(v.valor_pago, 0::numeric) > 0::numeric AS avancou,
        CASE
            WHEN p.mensagem ~* '(api\.whatsapp\.com/send|wa\.me/)'::text THEN 'site_link'::text
            WHEN (p.payload_raw #>> '{adContext,entryPointConversionSource}'::text[]) = 'ctwa_ad'::text THEN 'anuncio'::text
            WHEN length(btrim(COALESCE(p.mensagem, ''::text))) >= 15 THEN 'texto'::text
            WHEN NULLIF(btrim(COALESCE(v.origem, ''::text)), ''::text) IS NOT NULL THEN 'campo'::text
            ELSE 'desconhecida'::text
        END AS origem_tipo,
        CASE
            WHEN p.mensagem ~* '(api\.whatsapp\.com/send|wa\.me/)'::text THEN "left"(btrim(COALESCE(crm_url_decode((regexp_match(p.mensagem, 'text=([^&]*)'::text))[1]), p.mensagem)), 120)
            WHEN (p.payload_raw #>> '{adContext,entryPointConversionSource}'::text[]) = 'ctwa_ad'::text THEN COALESCE(NULLIF(btrim(COALESCE(v.campanha_nome, ''::text)), ''::text), (('Anúncio '::text || initcap(COALESCE(NULLIF(p.payload_raw #>> '{adContext,entryPointConversionApp}'::text[], ''::text), 'Meta'::text))) || ' #'::text) || upper("left"(COALESCE(v.ctwa_token, crm_ctwa_token(p.payload_raw #> '{adContext,ctwaPayload}'::text[]), 'meta'::text), 8)))
            WHEN length(btrim(COALESCE(p.mensagem, ''::text))) >= 15 THEN "left"(btrim(p.mensagem), 120)
            WHEN NULLIF(btrim(COALESCE(v.origem, ''::text)), ''::text) IS NOT NULL THEN btrim(v.origem)
            ELSE 'Não identificada'::text
        END AS origem_rotulo,
    v.anuncio_id,
    v.data_entrada,
    v.data_venda
   FROM valid v
     LEFT JOIN primeira p ON p.cliente_crm_id = v.id
     LEFT JOIN venda_h vh ON vh.cliente_id = v.id;

create view public.crm_duplicados_grupos as
 WITH cards AS (
         SELECT c_1.id,
            c_1.telefone_norm,
            c_1.funil_id,
            c_1.nome,
            c_1.etapa,
            c_1.vendedor_id,
            c_1.data_entrada,
            c_1.ultima_mensagem_em,
            c_1.ultima_mensagem_direcao,
            (( SELECT count(*) AS count
                   FROM crm_conversas m
                  WHERE m.cliente_crm_id = c_1.id))::integer AS msgs,
            (( SELECT count(*) AS count
                   FROM vendas v
                  WHERE v.cliente_crm_id = c_1.id::text))::integer AS vendas,
            c_1.nome ~* '(teste|^test\y)'::text AS eh_teste,
            lower(btrim(regexp_replace(regexp_replace(c_1.nome, '\s+\d{4}$'::text, ''::text), '[^[:alpha:] ]'::text, ''::text, 'g'::text))) AS nome_base
           FROM clientes_crm c_1
          WHERE c_1.deleted_at IS NULL AND c_1.mesclado_para IS NULL AND c_1.telefone_norm IS NOT NULL AND COALESCE(c_1.distinto_confirmado, false) = false AND NOT crm_numero_da_casa(c_1.telefone_norm)
        ), g AS (
         SELECT cards.telefone_norm,
            cards.funil_id,
            count(*)::integer AS n,
            sum(cards.msgs)::integer AS msgs_total,
            count(*) FILTER (WHERE cards.vendas > 0)::integer AS c_venda,
            count(*) FILTER (WHERE cards.eh_teste)::integer AS c_teste,
            count(DISTINCT split_part(cards.nome_base, ' '::text, 1)) FILTER (WHERE cards.nome_base <> ''::text AND cards.nome_base !~ '^sem nome'::text) AS pn
           FROM cards
          GROUP BY cards.telefone_norm, cards.funil_id
         HAVING count(*) > 1
        )
 SELECT c.id,
    c.telefone_norm,
    c.funil_id,
    c.nome,
    c.etapa,
    c.vendedor_id,
    c.data_entrada,
    c.ultima_mensagem_em,
    c.ultima_mensagem_direcao,
    c.msgs,
    c.vendas,
    c.eh_teste,
    c.nome_base,
    g.n,
    g.msgs_total,
    g.c_venda,
        CASE
            WHEN g.c_teste > 0 THEN 'excluido_teste'::text
            WHEN g.pn > 1 THEN 'nomes_divergentes'::text
            WHEN g.c_venda > 0 THEN 'lote3_venda'::text
            WHEN g.msgs_total > 0 THEN 'lote2_conversa'::text
            ELSE 'lote1_seguro'::text
        END AS lote,
    row_number() OVER (PARTITION BY c.telefone_norm, c.funil_id ORDER BY (c.vendas > 0) DESC, c.msgs DESC, c.data_entrada, c.id) AS pos,
    first_value(c.id) OVER (PARTITION BY c.telefone_norm, c.funil_id ORDER BY (COALESCE(c.ultima_mensagem_em, c.data_entrada)) DESC, c.id) AS id_mais_recente
   FROM cards c
     JOIN g ON g.telefone_norm = c.telefone_norm AND g.funil_id = c.funil_id;

create view public.crm_leads_cpl_base as
 SELECT c.id,
    c.data_entrada,
    c.anuncio_id,
    c.campanha_nome,
    c.anuncio_app,
    c.funil_id,
    c.vendedor_id
   FROM clientes_crm c
     JOIN crm_lead_reentrada() cl(id, classe, card_anterior, dias_desde_ultimo, desfecho_anterior) ON cl.id = c.id AND cl.classe = 'novo'::text
  WHERE c.deleted_at IS NULL AND c.mesclado_para IS NULL AND crm_lead_fora_campanha(c.*) IS NULL;

create view public.vw_crm_entrada_parada as
 SELECT id,
    chegou_em,
    origem,
    estado,
    tentativas,
    motivo,
    tentativas >= 5 AS desistiu,
    ((((((envelope -> 'entry'::text) -> 0) -> 'changes'::text) -> 0) -> 'value'::text) -> 'metadata'::text) ->> 'display_phone_number'::text AS numero_da_casa,
    envelope
   FROM crm_entrada_bruta b
  WHERE estado <> 'processada'::text
  ORDER BY chegou_em;
