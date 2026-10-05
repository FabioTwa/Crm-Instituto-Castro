-- 06 Funcoes do nucleo
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- 
-- check_function_bodies = off: funcao SQL e validada na criacao, e varias se
-- leem em ciclo (ou leem uma view do arquivo 07). Assim a ordem nao importa.
--
-- crm_mesclar_grupo tem a lista das 16 tabelas que apontam para um card, metade
-- delas da camada de venda (dados_preenchidos, formulario_clientes,
-- inadimplencia_*, rfm_segmentos...). A funcao pula a tabela que nao existe
-- nesta base: se uma dessas tabelas for criada, a mescla passa a move-la sozinha.

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.audit_trigger_func()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  op TEXT;
  dados_antes JSONB;
  dados_depois JSONB;
  user_atual TEXT;
  registro_id_val TEXT;
BEGIN
  BEGIN
    user_atual := auth.uid()::TEXT;
  EXCEPTION WHEN OTHERS THEN
    user_atual := NULL;
  END;

  IF TG_OP = 'INSERT' THEN
    op := 'INSERT';
    dados_antes := NULL;
    dados_depois := to_jsonb(NEW);
    registro_id_val := (to_jsonb(NEW)->>'id');
  ELSIF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW)->>'deleted_at') IS NOT NULL AND (to_jsonb(OLD)->>'deleted_at') IS NULL THEN
      op := 'SOFT_DELETE';
    ELSIF (to_jsonb(NEW)->>'deleted_at') IS NULL AND (to_jsonb(OLD)->>'deleted_at') IS NOT NULL THEN
      op := 'RESTORE';
    ELSE
      op := 'UPDATE';
    END IF;
    dados_antes := to_jsonb(OLD);
    dados_depois := to_jsonb(NEW);
    registro_id_val := (to_jsonb(NEW)->>'id');
  ELSIF TG_OP = 'DELETE' THEN
    op := 'DELETE';
    dados_antes := to_jsonb(OLD);
    dados_depois := NULL;
    registro_id_val := (to_jsonb(OLD)->>'id');
  END IF;

  BEGIN
    INSERT INTO audit_log_critico (tabela, operacao, registro_id, user_id, dados_antes, dados_depois)
    VALUES (TG_TABLE_NAME, op, registro_id_val, user_atual, dados_antes, dados_depois);
  EXCEPTION WHEN OTHERS THEN
    -- Auditoria nao deve travar operacao real
    NULL;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bloquear_hard_delete_clientes()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'PROTECAO: hard-delete em clientes_crm esta bloqueado. Use soft-delete (UPDATE deleted_at = NOW()).';
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.crm_acao_adiar(p_cliente uuid, p_dias integer DEFAULT 1)
 RETURNS void
 LANGUAGE sql
AS $function$
  insert into acoes_dia (cliente_id, vendedor_id, tipo, titulo, data_prevista, concluida)
  select p_cliente, c.vendedor_id, 'adiar', 'Adiado pelo vendedor',
         now() + make_interval(days => greatest(coalesce(p_dias, 1), 1)), false
  from clientes_crm c where c.id = p_cliente;
$function$;

CREATE OR REPLACE FUNCTION public.crm_acoes_dia(p_vendedor text DEFAULT NULL::text, p_limite integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with convertidos as (
  select distinct v.cliente_crm_id as cid from vendas v
  where v.ativa is not false and v.deleted_at is null and coalesce(v.excluida_contabilizacao, false) = false
),
compradores as (
  select distinct c.telefone_norm from clientes_crm c
  join convertidos cv on cv.cid = c.id::text where c.telefone_norm is not null
),
fila as (
  select c.id, c.nome, c.telefone, c.telefone_norm, c.vendedor_id, c.vendedor_nome, c.etapa, c.funil_id,
         c.ultima_mensagem_em
  from clientes_crm c
  where c.deleted_at is null and c.mesclado_para is null
    and crm_telefone_valido(c.telefone)
    and not crm_numero_da_casa(c.telefone_norm)
    and crm_lead_aguardando(c.ultima_mensagem_direcao)
    and c.etapa not in ('fechado', 'perdido')
    and (p_vendedor is null or c.vendedor_id = p_vendedor)
    and not exists (select 1 from convertidos cv where cv.cid = c.id::text)
    and not exists (select 1 from acoes_dia a where a.cliente_id = c.id and a.tipo = 'adiar'
        and coalesce(a.concluida, false) = false and a.data_prevista > now())
),
seq as (
  select m.cliente_crm_id, m.direcao, m.criada_em,
         lag(m.direcao) over (partition by m.cliente_crm_id order by m.criada_em) as anterior
  from crm_conversas m where m.cliente_crm_id in (select id from fila)
),
eng as (
  select cliente_crm_id as id,
         count(*) filter (where direcao = 'recebida')::int as msgs,
         count(*) filter (where direcao = 'recebida' and anterior = 'enviada')::int as voltas,
         max(criada_em) filter (where direcao = 'recebida') as ultima_msg
  from seq group by 1
),
ordenada as (
  select f.*, coalesce(e.msgs, 0) as msgs, coalesce(e.voltas, 0) as voltas,
    case when e.msgs >= 5 and e.voltas >= 2 and e.ultima_msg > now() - interval '7 days' then 'engajado'
         when e.msgs >= 2 and e.ultima_msg > now() - interval '14 days' then 'morno' else 'frio' end as nivel,
    case when e.msgs >= 5 and e.voltas >= 2 and e.ultima_msg > now() - interval '7 days' then 1
         when e.msgs >= 2 and e.ultima_msg > now() - interval '14 days' then 2 else 3 end as rank_nivel,
    round(extract(epoch from (now() - f.ultima_mensagem_em)) / 3600.0) as horas_esperando
  from fila f left join eng e on e.id = f.id
),
pagina as (select * from ordenada order by rank_nivel, ultima_mensagem_em nulls last limit greatest(coalesce(p_limite, 100), 1)),
completa as (
  select p.*, coalesce(et.label, et.nome, p.etapa) as etapa_label, coalesce(fu.nome, 'Sem funil') as funil_nome,
    (select m.exibicao from crm_conversas m where m.cliente_crm_id = p.id and m.direcao = 'recebida' and m.exibicao is not null
      order by m.criada_em desc limit 1) as ultima_mensagem,
    (select a.resultado from crm_conversa_analise a where a.cliente_crm_id = p.id order by a.analisada_em desc limit 1) as ia,
    exists (select 1 from compradores co where co.telefone_norm = p.telefone_norm) as ja_comprou,
    cl.classe, cl.dias_desde_ultimo, cl.desfecho_anterior
  from pagina p
  left join crm_funil_etapas et on et.funil_id = p.funil_id and et.nome = p.etapa
  left join crm_funis fu on fu.id = p.funil_id
  left join crm_lead_reentrada() cl on cl.id = p.id
)
select jsonb_build_object(
  'itens', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'nome', nome, 'telefone', telefone, 'vendedor_id', vendedor_id, 'vendedor_nome', vendedor_nome,
      'funil_nome', funil_nome, 'etapa_label', etapa_label, 'nivel', nivel, 'msgs', msgs, 'voltas', voltas,
      'horas_esperando', horas_esperando, 'ultima_mensagem_em', ultima_mensagem_em,
      'ultima_mensagem', left(coalesce(ultima_mensagem, ''), 400),
      'classe', classe, 'dias_desde_ultimo', dias_desde_ultimo, 'desfecho_anterior', desfecho_anterior,
      'ja_comprou', ja_comprou, 'ia', ia) order by rank_nivel, ultima_mensagem_em), '[]'::jsonb) from completa),
  'resumo', (select jsonb_build_object('total', count(*)::int,
      'engajados', count(*) filter (where nivel = 'engajado')::int,
      'mornos', count(*) filter (where nivel = 'morno')::int,
      'frios', count(*) filter (where nivel = 'frio')::int,
      'mais_antigo_h', coalesce(max(horas_esperando), 0)::int) from ordenada),
  'com_ia', (select count(*) filter (where ia is not null)::int from completa),
  'adiados', (select count(*)::int from acoes_dia a join clientes_crm c on c.id = a.cliente_id
              where a.tipo = 'adiar' and coalesce(a.concluida, false) = false and a.data_prevista > now()
                and c.deleted_at is null and (p_vendedor is null or c.vendedor_id = p_vendedor)),
  'ia_ligada', (select valor = 'true' from crm_ia_config where chave = 'ligada')
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_analise_origem_conversao(p_vendedor text DEFAULT NULL::text, p_data_ini date DEFAULT NULL::date, p_data_fim date DEFAULT NULL::date, p_modo text DEFAULT NULL::text)
 RETURNS TABLE(origem_rotulo text, recebidos bigint, avancaram bigint, vendas bigint, taxa_conv numeric, valor_total numeric)
 LANGUAGE sql
 STABLE
AS $function$
with b as (
  select * from public.crm_analise_leads_base bb
  where bb.anuncio_id is null
    and (p_vendedor is null or bb.vendedor_id = p_vendedor)
    and (
      (p_data_ini is null and p_data_fim is null)
      or (coalesce(p_modo,'entrada') = 'venda' and bb.data_venda is not null
          and (p_data_ini is null or bb.data_venda >= p_data_ini)
          and (p_data_fim is null or bb.data_venda < (p_data_fim + 1)))
      or (coalesce(p_modo,'entrada') <> 'venda'
          and (p_data_ini is null or bb.data_entrada >= p_data_ini)
          and (p_data_fim is null or bb.data_entrada < (p_data_fim + 1)))
    )
)
select origem_rotulo,
  count(*) as recebidos,
  count(*) filter (where avancou) as avancaram,
  count(*) filter (where virou_venda) as vendas,
  round(count(*) filter (where virou_venda)*100.0/nullif(count(*),0),1) as taxa_conv,
  coalesce(sum(coalesce(valor_pago,0)) filter (where virou_venda),0) as valor_total
from b group by origem_rotulo
order by vendas desc, valor_total desc, recebidos desc;
$function$;

CREATE OR REPLACE FUNCTION public.crm_analise_origem_ranking(p_vendedor text DEFAULT NULL::text, p_data_ini date DEFAULT NULL::date, p_data_fim date DEFAULT NULL::date, p_modo text DEFAULT NULL::text)
 RETURNS TABLE(origem_rotulo text, origem_tipo text, quantidade bigint, pct numeric)
 LANGUAGE sql
 STABLE
AS $function$
with b as (
  select origem_rotulo, origem_tipo from public.crm_analise_leads_base bb
  where bb.anuncio_id is null
    and (p_vendedor is null or bb.vendedor_id = p_vendedor)
    and (
      (p_data_ini is null and p_data_fim is null)
      or (coalesce(p_modo,'entrada') = 'venda' and bb.data_venda is not null
          and (p_data_ini is null or bb.data_venda >= p_data_ini)
          and (p_data_fim is null or bb.data_venda < (p_data_fim + 1)))
      or (coalesce(p_modo,'entrada') <> 'venda'
          and (p_data_ini is null or bb.data_entrada >= p_data_ini)
          and (p_data_fim is null or bb.data_entrada < (p_data_fim + 1)))
    )
),
tot as (select count(*)::numeric t from b)
select b.origem_rotulo, min(b.origem_tipo) as origem_tipo, count(*) as quantidade,
       round(count(*)*100.0/nullif((select t from tot),0),1) as pct
from b group by b.origem_rotulo
order by quantidade desc, origem_rotulo;
$function$;

CREATE OR REPLACE FUNCTION public.crm_atendimento_leads(p_inicio date, p_fim date, p_faixa text, p_vendedores text[] DEFAULT NULL::text[], p_limit integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with base as (
  select r.*, extract(epoch from (r.primeira_resposta_em - r.lead_chegou_em))/60 as min_resp
  from crm_leads_recebidos(p_inicio, p_fim, p_vendedores) r
),
semnum as (
  select c.id, c.nome, c.telefone, c.etapa, coalesce(c.vendedor_nome,'Sem vendedor') as vendedor_nome,
         c.lead_chegou_em, c.primeira_resposta_em, c.ultima_mensagem_em, c.ultima_mensagem_direcao,
         null::numeric as min_resp
  from clientes_crm c
  where c.deleted_at is null and not crm_telefone_valido(c.telefone)
    and c.data_entrada >= p_inicio::timestamp and c.data_entrada < (p_fim + 1)::timestamp
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
),
alvo as (
  select id, nome, telefone, etapa, vendedor_nome, lead_chegou_em, primeira_resposta_em, ultima_mensagem_em, ultima_mensagem_direcao, min_resp
  from base b
  where case
    when p_faixa = 'cliente_nunca' then
      (select count(*) from crm_conversas k where k.cliente_crm_id = b.id and k.direcao = 'enviada') > 0
      and (select count(*) from crm_conversas k where k.cliente_crm_id = b.id and k.direcao = 'recebida') = 0
    when p_faixa = 'aguardando' then b.aguardando
    else b.lead_chegou_em is not null and crm_faixa_resposta(b.min_resp) = p_faixa end
  union all
  select id, nome, telefone, etapa, vendedor_nome, lead_chegou_em, primeira_resposta_em, ultima_mensagem_em, ultima_mensagem_direcao, min_resp
  from semnum where p_faixa = 'sem_numero'
)
select jsonb_build_object(
  'faixa', p_faixa,
  'total', (select count(*) from alvo),
  'leads', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'nome', nome, 'telefone', telefone, 'etapa', etapa, 'vendedor', vendedor_nome,
      'chegou_em', lead_chegou_em, 'respondido_em', primeira_resposta_em, 'espera_min', round(min_resp),
      'ultima_mensagem_em', ultima_mensagem_em, 'aguardando', crm_lead_aguardando(ultima_mensagem_direcao)
    ) order by coalesce(min_resp, 9999999) desc, ultima_mensagem_em desc nulls last), '[]'::jsonb)
    from (select * from alvo order by coalesce(min_resp, 9999999) desc limit p_limit) x)
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_atendimento_resumo(p_inicio date, p_fim date, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with todos as (select * from crm_leads_recebidos(p_inicio, p_fim, p_vendedores)),
validos as (select * from todos where not public.fn_lead_prospectado(id)),
com_hora as (
  select v.*, extract(epoch from (v.primeira_resposta_em - v.lead_chegou_em))/60 as min_bruto
  from validos v where v.lead_chegou_em is not null
),
medivel as (select c.*, c.min_bruto as min_resp from com_hora c where c.min_bruto is null or c.min_bruto >= 0),
comfaixa as (select m.*, crm_faixa_resposta(m.min_resp) as faixa from medivel m),
conversa as (
  select v.id,
         (select count(*) from crm_conversas k where k.cliente_crm_id = v.id and k.direcao = 'enviada') as enviadas,
         (select count(*) from crm_conversas k where k.cliente_crm_id = v.id and k.direcao = 'recebida') as recebidas
  from validos v
)
select jsonb_build_object(
  'periodo', jsonb_build_object('inicio', p_inicio, 'fim', p_fim),
  'topo', (select jsonb_build_object(
      'leads_recebidos', (select count(*) from validos),
      'base_medivel', (select count(*) from medivel),
      'nunca_respondidos', (select count(*) from medivel where primeira_resposta_em is null),
      'nunca_respondidos_pct', (select round(100.0*count(*) filter (where primeira_resposta_em is null)/nullif(count(*),0),1) from medivel),
      'mediana_min', (select round(percentile_cont(0.5) within group (order by min_resp)) from comfaixa where min_resp is not null),
      'media_min', (select round(avg(min_resp)) from comfaixa where min_resp is not null),
      'aguardando_agora', (select count(*) from validos where aguardando))),
  'faixas', (select coalesce(jsonb_agg(jsonb_build_object('faixa', faixa, 'ordem', crm_faixa_ordem(faixa), 'qtd', qtd, 'pct', round(100.0*qtd/nullif((select count(*) from comfaixa),0),1)) order by crm_faixa_ordem(faixa)), '[]'::jsonb)
      from (select faixa, count(*)::int as qtd from comfaixa group by 1) f),
  'por_vendedor', (select coalesce(jsonb_agg(jsonb_build_object('vendedor_id', vendedor_id, 'vendedor_nome', vendedor_nome, 'total', total, 'nunca', nunca, 'ate_1h', ate_1h, 'mediana_min', mediana) order by total desc), '[]'::jsonb)
      from (select vendedor_id, vendedor_nome, count(*)::int as total,
                   count(*) filter (where faixa = 'nunca')::int as nunca,
                   count(*) filter (where faixa in ('ate_5min','ate_1h'))::int as ate_1h,
                   round(percentile_cont(0.5) within group (order by min_resp)) as mediana
            from comfaixa group by 1,2) pv),
  'gargalos', jsonb_build_object(
      'vendedor_nunca_respondeu', (select count(*) from medivel where primeira_resposta_em is null),
      'cliente_nunca_respondeu', (select count(*) from conversa where enviadas > 0 and recebidas = 0)),
  'correlacao', (select coalesce(jsonb_agg(jsonb_build_object(
      'faixa', faixa, 'ordem', crm_faixa_ordem(faixa), 'leads', leads,
      'cliente_respondeu_pct', round(100.0*cli_resp/nullif(leads,0),1),
      'conversao_pct', round(100.0*conv/nullif(leads,0),1),
      'ticket_medio', round(ticket)) order by crm_faixa_ordem(faixa)), '[]'::jsonb)
      from (select cf.faixa, count(*)::int as leads,
                   count(*) filter (where (select count(*) from crm_conversas k where k.cliente_crm_id = cf.id and k.direcao='recebida' and k.criada_em > cf.primeira_resposta_em) > 0)::int as cli_resp,
                   count(*) filter (where crm_lead_convertido(cf.id))::int as conv,
                   avg((select avg(v.valor) from vendas v where v.cliente_crm_id = cf.id::text and v.ativa is not false and v.deleted_at is null and coalesce(v.excluida_contabilizacao,false)=false)) as ticket
            from comfaixa cf group by cf.faixa) cr),
  'prospectados', (select count(*)::int from todos where public.fn_lead_prospectado(id)),
  'ressalvas', jsonb_build_object(
      'sem_hora_chegada', (select count(*) from validos) - (select count(*) from com_hora),
      'tempo_negativo', (select count(*)::int from com_hora where min_bruto < 0),
      'sem_numero', crm_leads_sem_numero(p_inicio, p_fim, p_vendedores),
      'etapa_sem_ordem', (select count(*) from validos where etapa_ordem = 999))
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_buscar_ids(termo text)
 RETURNS TABLE(id uuid, veio_da_conversa boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with entrada as (
    select
      nullif(btrim(termo), '') as t,
      regexp_replace(coalesce(termo, ''), '[^0-9]', '', 'g') as dig
  ),
  por_card as (
    select c.id
    from public.clientes_crm c
    cross join entrada e
    where c.deleted_at is null
      and e.t is not null
      and (
        c.nome ilike '%' || e.t || '%'
        or (length(e.dig) >= 3 and regexp_replace(coalesce(c.telefone, ''), '[^0-9]', '', 'g') ilike '%' || e.dig || '%')
        or (length(e.dig) >= 3 and regexp_replace(coalesce(c.numero_whatsapp, ''), '[^0-9]', '', 'g') ilike '%' || e.dig || '%')
      )
    limit 2000
  ),
  por_conversa as (
    select distinct conv.cliente_crm_id as id
    from public.crm_conversas conv
    cross join entrada e
    join public.clientes_crm c2 on c2.id = conv.cliente_crm_id and c2.deleted_at is null
    where conv.cliente_crm_id is not null
      and e.t is not null
      and length(e.t) >= 3
      and conv.mensagem ilike '%' || e.t || '%'
    limit 2000
  )
  select u.id,
         bool_or(u.fonte = 'conversa') and not bool_or(u.fonte = 'card') as veio_da_conversa
  from (
    select id, 'card'::text as fonte from por_card
    union all
    select id, 'conversa'::text as fonte from por_conversa
  ) u
  group by u.id
  limit 3000;
$function$;

CREATE OR REPLACE FUNCTION public.crm_cards_irmaos(p_cliente_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with eu as (
    select id, telefone_norm, funil_id
    from public.clientes_crm
    where id = p_cliente_id and deleted_at is null and mesclado_para is null
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id',           o.id,
      'nome',         o.nome,
      'etapa',        o.etapa,
      'data_entrada', o.data_entrada,
      'conversas',    (select count(*) from public.crm_conversas k where k.cliente_crm_id = o.id),
      'vendas',       (select count(*) from public.vendas v
                        where v.cliente_crm_id = o.id::text and v.deleted_at is null and v.ativa)
    ) order by o.data_entrada),
    '[]'::jsonb)
  from eu
  join public.clientes_crm o
    on  o.telefone_norm = eu.telefone_norm
    and o.funil_id      = eu.funil_id
    and o.id           <> eu.id
    and o.deleted_at   is null
    and o.mesclado_para is null;
$function$;

CREATE OR REPLACE FUNCTION public.crm_cpl_resumo(p_ini date, p_fim date, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with periodo as (
  select c.*, cl.classe,
         coalesce(crm_lead_fora_campanha(c),
                  case when cl.classe <> 'novo' then 'reentrada_' || cl.classe end) as fora,
         crm_lead_atribuido(c) as tem_anuncio,
         (nullif(btrim(coalesce(c.google_campanha_id, '')), '') is not null) as do_google
  from clientes_crm c
  left join crm_lead_reentrada() cl on cl.id = c.id
  where c.deleted_at is null
    and c.data_entrada >= p_ini::timestamp
    and c.data_entrada <  (p_fim + 1)::timestamp
    and (p_funil is null or c.funil_id = p_funil)
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
)
select jsonb_build_object(
  'cards',          (select count(*)::int from periodo),
  'base',           (select count(*)::int from periodo where fora is null),
  'atribuidos',     (select count(*)::int from periodo where fora is null and tem_anuncio),
  'sem_atribuicao', (select count(*)::int from periodo where fora is null and not tem_anuncio),
  'do_google',      (select count(*)::int from periodo where fora is null and do_google),
  'fora',           (select coalesce(jsonb_object_agg(fora, qtd), '{}'::jsonb)
                     from (select fora, count(*)::int qtd from periodo where fora is not null group by 1) x),
  'gasto_conectado', (select exists (select 1 from mkt_gasto_campanha_dia g where g.dia between p_ini and p_fim))
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_ctwa_token(p jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when p is null or jsonb_typeof(p) <> 'object' then null else (
    select nullif(string_agg(chr((p->>k)::int), '' order by (k)::int), '')
    from jsonb_object_keys(p) as k
    where k ~ '^[0-9]+$'
  ) end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_desmesclar_grupo(p_sobrevivente uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  r record; n int := 0; n_cards int; n_restaurado int := 0;
  v_retrato jsonb; v_sets text; v_campos jsonb;
begin
  for r in select distinct tabela, coluna from crm_mescla_log where sobrevivente = p_sobrevivente loop
    execute format(
      'update %1$I t set %2$I = l.absorvido%3$s from crm_mescla_log l
       where l.sobrevivente = $1 and l.tabela = %1$L and l.coluna = %2$L and t.id::text = l.registro_id',
      r.tabela, r.coluna,
      case when r.tabela in ('vendas','dados_preenchidos','formulario_clientes','leads_diario') then '::text' else '' end)
    using p_sobrevivente;
    get diagnostics n_cards = row_count; n := n + n_cards;
  end loop;
  delete from crm_mescla_log where sobrevivente = p_sobrevivente;

  update clientes_crm set mesclado_para = null, mesclado_em = null where mesclado_para = p_sobrevivente;
  get diagnostics n_cards = row_count;

  -- O sobrevivente volta a ser o que era. Sem isto, desfazer era parcial.
  select retrato, campos_carregados into v_retrato, v_campos
  from public.crm_mescla_retrato
  where sobrevivente = p_sobrevivente
  order by criado_em, id limit 1;

  if v_retrato is not null then
    select string_agg(format('%I = ($1 ->> %L)::%s', a.attname, a.attname,
                              format_type(a.atttypid, a.atttypmod)), ', ')
      into v_sets
    from pg_attribute a
    where a.attrelid = 'public.clientes_crm'::regclass
      and a.attnum > 0 and not a.attisdropped
      and a.attgenerated = ''
      and a.attname <> 'id'
      and v_retrato ? a.attname;

    if v_sets is not null then
      execute format('update clientes_crm set %s where id = $2', v_sets)
        using v_retrato, p_sobrevivente;
      n_restaurado := 1;
    end if;
    delete from public.crm_mescla_retrato where sobrevivente = p_sobrevivente;
  else
    -- Mescla anterior a 24/09/2026 nao tem retrato: nao da para restaurar o
    -- card, e dizer que deu seria mentira. O resto da volta acontece.
    update clientes_crm set retornos = null where id = p_sobrevivente;
  end if;

  return jsonb_build_object(
    'cards_devolvidos', n_cards,
    'linhas_devolvidas', n,
    'sobrevivente_restaurado', n_restaurado = 1,
    'campos_que_tinham_sido_carregados', coalesce(v_campos, '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.crm_engajamento(p_vendedores text[] DEFAULT NULL::text[], p_funil uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with base as (
  select c.id, crm_lead_aguardando(c.ultima_mensagem_direcao) as aguardando, c.ultima_mensagem_em,
         coalesce(e.nivel, 'frio') as nivel
  from clientes_crm c
  left join crm_engajamento_por_card() e on e.id = c.id
  where c.deleted_at is null
    and c.mesclado_para is null
    and crm_telefone_valido(c.telefone)
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
    and (p_funil is null or c.funil_id = p_funil)
)
select jsonb_build_object(
  'aguardando_total',     (select count(*) from base where aguardando),
  'engajados',            (select count(*) from base where nivel = 'engajado'),
  'engajados_aguardando', (select count(*) from base where nivel = 'engajado' and aguardando),
  'espera_media_h',       (select round(avg(extract(epoch from (now() - ultima_mensagem_em))/3600)) from base where nivel = 'engajado' and aguardando),
  'ids_engajados_aguardando', (select coalesce(jsonb_agg(id), '[]'::jsonb) from base where nivel = 'engajado' and aguardando),
  'por_nivel', (select coalesce(jsonb_agg(jsonb_build_object('nivel', nivel, 'cards', n, 'aguardando', ag) order by nivel), '[]'::jsonb)
                from (select nivel, count(*) as n, count(*) filter (where aguardando) as ag from base group by nivel) x)
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_engajamento_por_card(p_ref timestamp with time zone DEFAULT now())
 RETURNS TABLE(id uuid, msgs integer, voltas integer, ultima_msg timestamp with time zone, nivel text)
 LANGUAGE sql
 STABLE
AS $function$
  with seq as (
    select cliente_crm_id, direcao, criada_em,
           lag(direcao) over (partition by cliente_crm_id order by criada_em) as anterior
    from public.crm_conversas
    where criada_em <= p_ref
  ), agg as (
    select cliente_crm_id as id,
           count(*) filter (where direcao = 'recebida')::int as msgs,
           count(*) filter (where direcao = 'recebida' and anterior = 'enviada')::int as voltas,
           max(criada_em) filter (where direcao = 'recebida') as ultima_msg
    from seq group by 1
  )
  select id, msgs, voltas, ultima_msg,
         case
           when msgs >= 5 and voltas >= 2 and ultima_msg > p_ref - interval '7 days' then 'engajado'
           when msgs >= 2 and ultima_msg > p_ref - interval '14 days' then 'morno'
           else 'frio' end as nivel
  from agg;
$function$;

CREATE OR REPLACE FUNCTION public.crm_extrair_referral(p_cliente_id uuid, p_referral jsonb, p_reconstruido boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
declare
  v_card record; n int;
begin
  if p_cliente_id is null or p_referral is null or jsonb_typeof(p_referral) <> 'object' then
    return false;
  end if;
  if coalesce(p_referral->>'source_type','') <> 'ad' then
    return false;   -- so anuncio pago, igual ao webhook
  end if;

  select anuncio_id, anuncio_source_type, anuncio_media_type, anuncio_image_url,
         anuncio_video_url, anuncio_thumbnail_url, anuncio_welcome_message
    into v_card
  from public.clientes_crm where id = p_cliente_id;
  if not found then return false; end if;

  -- Vale o primeiro anuncio: so completa quando o referral e do anuncio que o
  -- card ja carrega. Card sem anuncio_id nao ganha metadado solto.
  if v_card.anuncio_id is null or v_card.anuncio_id <> coalesce(p_referral->>'source_id','') then
    return false;
  end if;

  update public.clientes_crm set
    anuncio_source_type     = coalesce(anuncio_source_type,     nullif(p_referral->>'source_type','')),
    anuncio_media_type      = coalesce(anuncio_media_type,      nullif(p_referral->>'media_type','')),
    anuncio_image_url       = coalesce(anuncio_image_url,       nullif(p_referral->>'image_url','')),
    anuncio_video_url       = coalesce(anuncio_video_url,       nullif(p_referral->>'video_url','')),
    anuncio_thumbnail_url   = coalesce(anuncio_thumbnail_url,   nullif(p_referral->>'thumbnail_url','')),
    anuncio_welcome_message = coalesce(anuncio_welcome_message, nullif(p_referral->'welcome_message'->>'text','')),
    anuncio_referral_extraido_em = case when p_reconstruido then coalesce(anuncio_referral_extraido_em, now())
                                        else anuncio_referral_extraido_em end
  where id = p_cliente_id
    and (anuncio_source_type is null or anuncio_media_type is null or anuncio_image_url is null
         or anuncio_video_url is null or anuncio_thumbnail_url is null or anuncio_welcome_message is null);
  get diagnostics n = row_count;
  return n > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_faixa_ordem(p_faixa text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_faixa
    when 'ate_5min' then 1 when 'ate_1h' then 2 when 'ate_2h' then 3
    when 'ate_5h' then 4 when 'ate_8h' then 5 when 'ate_1dia' then 6
    when 'ate_2dias' then 7 when 'ate_5dias' then 8 when 'ate_1semana' then 9
    when 'mais_1semana' then 10 when 'nunca' then 11 else 99 end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_faixa_resposta(p_minutos numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_minutos is null   then 'nunca'
    when p_minutos <= 5      then 'ate_5min'
    when p_minutos <= 60     then 'ate_1h'
    when p_minutos <= 120    then 'ate_2h'
    when p_minutos <= 300    then 'ate_5h'
    when p_minutos <= 480    then 'ate_8h'
    when p_minutos <= 1440   then 'ate_1dia'
    when p_minutos <= 2880   then 'ate_2dias'
    when p_minutos <= 7200   then 'ate_5dias'
    when p_minutos <= 10080  then 'ate_1semana'
    else 'mais_1semana' end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_jornada_resumo(p_ini date, p_fim date, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with ev as (
  select e.cliente_id, e.funil_id, e.vendedor_id, e.tipo_evento, e.created_at
  from crm_eventos_jornada e
  where e.deleted_at is null and e.created_at >= p_ini::timestamp and e.created_at < (p_fim + 1)::timestamp
    and (p_funil is null or e.funil_id = p_funil)
    and (p_vendedores is null or e.vendedor_id = any(p_vendedores))
    and not public.fn_lead_prospectado(e.cliente_id)
  union all
  select r.id, r.funil_id, r.vendedor_id, 'lead_criado', r.data_entrada
  from crm_leads_recebidos(p_ini, p_fim, p_vendedores, p_funil) r
  where not public.fn_lead_prospectado(r.id)
  union all
  select c.id, c.funil_id, c.vendedor_id, 'pagamento_confirmado', v.data_fechamento::timestamptz
  from vendas v join clientes_crm c on c.id::text = v.cliente_crm_id
  where v.ativa is not false and v.deleted_at is null and coalesce(v.excluida_contabilizacao,false) = false
    and v.data_fechamento >= p_ini and v.data_fechamento <= p_fim and c.deleted_at is null
    and (p_funil is null or c.funil_id = p_funil)
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
    and not public.fn_lead_prospectado(c.id)
),
prim as (select cliente_id, funil_id, vendedor_id, tipo_evento, min(created_at) as t from ev group by 1,2,3,4),
tipos as (select * from (values ('lead_criado',1),('link_gerado',2),('dados_preenchidos',3),('contrato_assinado',4),('pagamento_confirmado',5)) t(tipo, ordem)),
conv as (select t.tipo, t.ordem, count(distinct p.cliente_id)::int as qtd from tipos t left join prim p on p.tipo_evento = t.tipo group by t.tipo, t.ordem),
conv2 as (select c.*, lag(qtd) over (order by ordem) as qtd_anterior, (select qtd from conv where tipo = 'lead_criado') as total from conv c),
passos as (select * from (values ('lead_criado','link_gerado','Card → Link',1), ('link_gerado','dados_preenchidos','Link → Dados',2), ('dados_preenchidos','contrato_assinado','Dados → Contrato',3), ('contrato_assinado','pagamento_confirmado','Contrato → Pagto',4)) p(de, para, rotulo, ordem)),
dif as (select ps.rotulo, ps.ordem, a.vendedor_id, a.funil_id, extract(epoch from (b.t - a.t)) * 1000 as ms
        from passos ps join prim a on a.tipo_evento = ps.de join prim b on b.tipo_evento = ps.para and b.cliente_id = a.cliente_id where b.t >= a.t),
tempos as (select ps.rotulo, ps.ordem, avg(d.ms) as media_ms, count(d.ms)::int as qtd from passos ps left join dif d on d.rotulo = ps.rotulo group by ps.rotulo, ps.ordem),
tempo_vend as (select vendedor_id, sum(media) as total_ms from (select vendedor_id, rotulo, avg(ms) as media from dif where vendedor_id is not null group by 1,2) x group by 1),
tempo_funil as (select funil_id, sum(media) as total_ms from (select funil_id, rotulo, avg(ms) as media from dif where funil_id is not null group by 1,2) x group by 1),
por_vend as (select coalesce(u.name, p.vendedor_id) as nome, p.vendedor_id,
                    count(distinct p.cliente_id) filter (where p.tipo_evento='lead_criado')::int as leads,
                    count(distinct p.cliente_id) filter (where p.tipo_evento='pagamento_confirmado')::int as pagos
             from prim p left join users u on u.id::text = p.vendedor_id where p.vendedor_id is not null group by 1,2),
por_funil as (select coalesce(f.nome, 'Sem funil') as nome, p.funil_id,
                     count(distinct p.cliente_id) filter (where p.tipo_evento='lead_criado')::int as leads,
                     count(distinct p.cliente_id) filter (where p.tipo_evento='pagamento_confirmado')::int as pagos
              from prim p left join crm_funis f on f.id = p.funil_id where p.funil_id is not null group by 1,2)
select jsonb_build_object(
  'conversao', (select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'qtd', qtd, 'pctTotal', round(100.0*qtd/nullif(total,0),1), 'pctAnterior', case when ordem = 1 then 100 else round(100.0*qtd/nullif(qtd_anterior,0),1) end) order by ordem), '[]'::jsonb) from conv2),
  'metricas', (select coalesce(jsonb_agg(jsonb_build_object('label', rotulo, 'mediaMs', round(media_ms), 'qtd', qtd) order by ordem), '[]'::jsonb) from tempos),
  'porVendedor', (select coalesce(jsonb_agg(jsonb_build_object('nome', pv.nome, 'vendedor_id', pv.vendedor_id, 'qtdLeads', pv.leads, 'qtdConvertidos', pv.pagos, 'conversaoPct', round(100.0*pv.pagos/nullif(pv.leads,0),1), 'tempoTotalMs', round(coalesce(tv.total_ms,0))) order by pv.pagos::numeric/nullif(pv.leads,0) desc nulls last), '[]'::jsonb) from por_vend pv left join tempo_vend tv on tv.vendedor_id = pv.vendedor_id),
  'porFunil', (select coalesce(jsonb_agg(jsonb_build_object('nome', pf.nome, 'funil_id', pf.funil_id, 'qtdLeads', pf.leads, 'qtdConvertidos', pf.pagos, 'conversaoPct', round(100.0*pf.pagos/nullif(pf.leads,0),1), 'tempoTotalMs', round(coalesce(tf.total_ms,0))) order by pf.pagos::numeric/nullif(pf.leads,0) desc nulls last), '[]'::jsonb) from por_funil pf left join tempo_funil tf on tf.funil_id = pf.funil_id),
  'leadsRecentes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'etapa', etapa, 'funil_id', funil_id, 'vendedor_id', vendedor_id, 'data_entrada', data_entrada, 'aguardando', aguardando) order by data_entrada desc), '[]'::jsonb)
      from (select * from crm_leads_recebidos(p_ini, p_fim, p_vendedores, p_funil) r where not public.fn_lead_prospectado(r.id) order by data_entrada desc limit 30) x),
  'totalEventos', (select count(*) from ev)
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_jornada_secoes(p_ini date, p_fim date, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with base as (
  select least(p_ini, (date_trunc('month', current_date) - interval '11 months')::date) as ini,
         greatest(p_fim, current_date) as fim
),
leads as (
  select r.id, public.fn_dia_local(r.data_entrada) as dia
  from base b, lateral crm_leads_recebidos(b.ini, b.fim, p_vendedores, p_funil) r
),
pagos as (
  select distinct v.cliente_crm_id as id, v.data_fechamento as dia
  from vendas v join clientes_crm c on c.id::text = v.cliente_crm_id
  where v.ativa is not false and v.deleted_at is null and coalesce(v.excluida_contabilizacao,false) = false
    and v.data_fechamento >= (select ini from base) and v.data_fechamento <= (select fim from base)
    and c.deleted_at is null
    and (p_funil is null or c.funil_id = p_funil)
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
),
janelas as (
  select d,
         (select count(*) from leads where dia >= current_date - d and dia <= current_date)::int as leads,
         (select count(distinct id) from pagos where dia >= current_date - d and dia <= current_date)::int as pagos
  from unnest(array[7,15,30,60]) as d
),
meses as (
  select to_char(m, 'YYYY-MM') as key, m::date as ini, (m + interval '1 month')::date as fim
  from generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month') m
),
coortes as (
  select m.key,
         (select count(*) from leads l where l.dia >= m.ini and l.dia < m.fim)::int as total,
         (select count(distinct p.id) from pagos p where p.dia >= m.ini and p.dia < m.fim)::int as convertidos
  from meses m
),
vendedores as (
  select u.id::text as id, u.name from users u where u.perfil = 'Vendedor' and u.status = 'ativo'
),
convertidos as (
  select distinct v.cliente_crm_id as id from vendas v
  where v.ativa is not false and v.deleted_at is null and coalesce(v.excluida_contabilizacao,false) = false
),
ativos as (
  select c.id, c.vendedor_id, (current_date - c.updated_at::date) as dias
  from clientes_crm c
  where c.deleted_at is null and c.vendedor_id is not null
    and c.etapa not in ('fechado', 'perdido')
    and (p_funil is null or c.funil_id = p_funil)
    and not exists (select 1 from convertidos cv where cv.id = c.id::text)
),
heat as (
  select vd.id, vd.name,
         count(a.id) filter (where a.dias <= 3)::int as f0,
         count(a.id) filter (where a.dias between 4 and 7)::int as f1,
         count(a.id) filter (where a.dias between 8 and 14)::int as f2,
         count(a.id) filter (where a.dias >= 15)::int as f3,
         count(a.id)::int as total,
         count(a.id) filter (where a.dias > 7)::int as parados
  from vendedores vd
  left join ativos a on a.vendedor_id = vd.id and (p_vendedores is null or a.vendedor_id = any(p_vendedores))
  group by vd.id, vd.name
),
fechados_sem_pagto as (
  select c.id, c.nome from clientes_crm c
  where c.deleted_at is null and c.etapa = 'fechado'
    and not exists (select 1 from convertidos cv where cv.id = c.id::text)
),
sem_vendedor as (
  select c.id, c.nome from clientes_crm c where c.deleted_at is null and c.vendedor_id is null
),
orfaos as (
  select c.id, c.nome, c.etapa from clientes_crm c
  left join crm_funil_etapas e on e.funil_id = c.funil_id and e.nome = c.etapa
  where c.deleted_at is null and c.funil_id is not null and c.etapa <> 'perdido' and e.funil_id is null
),
incong as (
  select 1 as ordem, 'alta' as severidade, 'Cards em "fechado" sem pagamento confirmado' as titulo,
         (select count(*) from fechados_sem_pagto)::int as qtd,
         (select coalesce(jsonb_agg(nome), '[]'::jsonb) from (select nome from fechados_sem_pagto limit 3) x) as exemplos
  union all
  select 2, 'media', 'Leads sem vendedor responsável',
         (select count(*) from sem_vendedor)::int,
         (select coalesce(jsonb_agg(nome), '[]'::jsonb) from (select nome from sem_vendedor limit 3) x)
  union all
  select 3, 'alta', 'Cards com etapa inexistente no funil (invisíveis no kanban)',
         (select count(*) from orfaos)::int,
         (select coalesce(jsonb_agg(nome || ' (' || etapa || ')'), '[]'::jsonb) from (select nome, etapa from orfaos limit 3) x)
)
select jsonb_build_object(
  'meta', jsonb_build_object(
     'leads', (select count(*) from leads where dia >= p_ini and dia <= p_fim),
     'pagos', (select count(distinct id) from pagos where dia >= p_ini and dia <= p_fim)),
  'janelas', (select jsonb_agg(jsonb_build_object('dias', d, 'leads', leads, 'pagos', pagos) order by d) from janelas),
  'coortes', (select jsonb_agg(jsonb_build_object('key', key, 'total', total, 'convertidos', convertidos) order by key) from coortes),
  'incongruencias', (select coalesce(jsonb_agg(jsonb_build_object('severidade', severidade, 'titulo', titulo, 'qtd', qtd, 'exemplos', exemplos) order by ordem), '[]'::jsonb) from incong where qtd > 0),
  'heatmap', jsonb_build_object(
     'vendedores', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from heat),
     'matriz', (select coalesce(jsonb_object_agg(id, jsonb_build_object('0-3', f0, '4-7', f1, '8-14', f2, '15+', f3, 'total', total)), '{}'::jsonb) from heat),
     'total', (select count(*) from ativos a where p_vendedores is null or a.vendedor_id = any(p_vendedores))),
  'parados', (select coalesce(jsonb_agg(jsonb_build_object('vendedor_id', id, 'parados', parados, 'totalAtivos', total)), '[]'::jsonb)
              from (select vd.id, count(a.id) filter (where a.dias > 7)::int as parados, count(a.id)::int as total
                    from vendedores vd left join ativos a on a.vendedor_id = vd.id group by vd.id) x)
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_lead_aguardando(p_direcao text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select p_direcao = 'recebida';
$function$;

CREATE OR REPLACE FUNCTION public.crm_lead_atribuido(c clientes_crm)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(btrim(coalesce(c.anuncio_id, '')), '') is not null
      or nullif(btrim(coalesce(c.google_campanha_id, '')), '') is not null;
$function$;

CREATE OR REPLACE FUNCTION public.crm_lead_convertido(p_cliente uuid, p_ini date DEFAULT NULL::date, p_fim date DEFAULT NULL::date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select exists (
    select 1 from public.vendas v
    where v.cliente_crm_id = p_cliente::text
      and v.ativa is not false
      and v.deleted_at is null
      and coalesce(v.excluida_contabilizacao, false) = false
      and (p_ini is null or v.data_fechamento >= p_ini)
      and (p_fim is null or v.data_fechamento <= p_fim)
  );
$function$;

CREATE OR REPLACE FUNCTION public.crm_lead_fora_campanha(c clientes_crm)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when not public.crm_telefone_valido(c.telefone) then 'sem_numero'
    when public.crm_numero_da_casa(c.telefone_norm) then 'numero_da_casa'
    when c.origem ~* '(lista|prospec|indica|evento|visita|planilha|importa)' then 'origem_manual'
    when public.crm_lead_atribuido(c) then null
    when c.created_at::date - c.data_entrada::date > 1 then 'registro_retroativo'
    when c.data_entrada < '2026-08-01' then 'sem_atribuicao_antes_de_agosto'
    else null end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_lead_reentrada()
 RETURNS TABLE(id uuid, classe text, card_anterior uuid, dias_desde_ultimo numeric, desfecho_anterior text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with conv as (
  select cliente_crm_id, min(criada_em) as primeira, max(criada_em) as ultima, count(*)::int as msgs
  from crm_conversas group by 1
),
compradores as (
  select distinct v.cliente_crm_id as cid from vendas v
  where v.ativa is not false and v.deleted_at is null and coalesce(v.excluida_contabilizacao, false) = false
),
base as (
  select c.id, c.etapa, c.data_entrada, c.telefone_norm as norm,
         cv.primeira, cv.ultima, coalesce(cv.msgs, 0) as msgs,
         (cp.cid is not null) as comprou
  from clientes_crm c
  left join conv cv on cv.cliente_crm_id = c.id
  left join compradores cp on cp.cid = c.id::text
  where c.deleted_at is null and c.mesclado_para is null and c.telefone_norm is not null
),
seq as (
  select b.*, row_number() over w as n,
    lag(b.id) over w as ant_id,
    lag(coalesce(b.ultima, b.data_entrada)) over w as ant_ref,
    lag(b.etapa) over w as ant_etapa,
    lag(b.comprou) over w as ant_comprou
  from base b window w as (partition by b.norm order by b.data_entrada, b.id)
)
select s.id,
  case when s.n = 1 then 'novo'
       when s.msgs > 0 and s.primeira >= s.ant_ref + interval '1 day' then 'remarketing'
       else 'duplicado' end,
  s.ant_id,
  case when s.n > 1 then round((extract(epoch from (coalesce(s.primeira, s.data_entrada) - s.ant_ref)) / 86400.0)::numeric, 1) end,
  case when s.n > 1 then (case when s.ant_comprou then 'comprou' else coalesce(s.ant_etapa, 'sem etapa') end) end
from seq s;
$function$;

CREATE OR REPLACE FUNCTION public.crm_leads_entrada_diaria(p_ini date, p_fim date, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with todos as (
    select r.id, public.fn_dia_local(r.data_entrada) as dia, r.funil_id,
           coalesce(f.nome, 'Sem funil') as funil_nome,
           coalesce(cl.classe, 'novo') as classe,
           public.fn_lead_prospectado(r.id) as prospectado,
           case
             when nullif(btrim(coalesce(c.anuncio_id, '')), '') is not null
               or nullif(btrim(coalesce(c.ctwa_token, '')), '') is not null
               or c.origem ~* '(anuncio|anúncio|instagram|facebook|meta_ads)' then 'meta'
             when nullif(btrim(coalesce(c.google_campanha_id, '')), '') is not null
               or c.origem ~* '(google|site|formul)' then 'google_site'
             when c.origem ~* '(lista|prospec|planilha|importa|indica|evento|visita|manual)' then 'comercial'
             else 'sem_origem'
           end as origem_grupo
      from crm_leads_recebidos(p_ini, p_fim, p_vendedores, p_funil) r
      join clientes_crm c on c.id = r.id
      left join crm_funis f on f.id = r.funil_id
      left join crm_lead_reentrada() cl on cl.id = r.id
  ),
  base as (select * from todos where not prospectado)
  select jsonb_build_object(
    'por_dia', (select coalesce(jsonb_agg(jsonb_build_object(
        'dia', dia, 'funil_id', funil_id, 'funil_nome', funil_nome, 'total', total,
        'remarketing', remarketing, 'meta', meta, 'google_site', google_site,
        'comercial', comercial, 'sem_origem', sem_origem) order by dia, funil_nome), '[]'::jsonb)
      from (select dia, funil_id, funil_nome, count(*)::int total,
                   count(*) filter (where classe = 'remarketing')::int remarketing,
                   count(*) filter (where origem_grupo = 'meta')::int meta,
                   count(*) filter (where origem_grupo = 'google_site')::int google_site,
                   count(*) filter (where origem_grupo = 'comercial')::int comercial,
                   count(*) filter (where origem_grupo = 'sem_origem')::int sem_origem
              from base group by 1,2,3) d),
    'por_funil', (select coalesce(jsonb_agg(jsonb_build_object(
        'funil_id', funil_id, 'funil_nome', funil_nome, 'total', total,
        'remarketing', remarketing, 'meta', meta, 'google_site', google_site,
        'comercial', comercial, 'sem_origem', sem_origem) order by total desc), '[]'::jsonb)
      from (select funil_id, funil_nome, count(*)::int total,
                   count(*) filter (where classe = 'remarketing')::int remarketing,
                   count(*) filter (where origem_grupo = 'meta')::int meta,
                   count(*) filter (where origem_grupo = 'google_site')::int google_site,
                   count(*) filter (where origem_grupo = 'comercial')::int comercial,
                   count(*) filter (where origem_grupo = 'sem_origem')::int sem_origem
              from base group by 1,2) f),
    'total', (select count(*)::int from base),
    'prospectados', (select count(*)::int from todos where prospectado)
  );
$function$;

CREATE OR REPLACE FUNCTION public.crm_leads_lista(p_inicio date, p_fim date, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[], p_fonte text DEFAULT NULL::text, p_etapa text DEFAULT NULL::text, p_busca text DEFAULT NULL::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, nome text, telefone text, email text, data_entrada timestamp with time zone, origem text, fonte text, anuncio_id text, anuncio_titulo text, anuncio_app text, campanha_origem text, etapa text, etapa_label text, funil_id uuid, funil_nome text, vendedor_nome text, ultima_mensagem_direcao text, ultima_mensagem_em timestamp with time zone, convertido boolean, classe text, dias_desde_ultimo numeric, desfecho_anterior text, total_registros bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with base as (
    select c.id, c.nome, c.telefone, c.email, c.data_entrada, c.origem,
        case when nullif(btrim(c.anuncio_app), '') is not null then 'Anuncio ' || lower(btrim(c.anuncio_app))
             when nullif(btrim(c.origem), '') is not null then btrim(c.origem)
             else 'Sem origem' end as fonte,
        c.anuncio_id, c.anuncio_titulo, c.anuncio_app, c.campanha_origem,
        c.etapa, coalesce(e.label, e.nome, c.etapa) as etapa_label,
        c.funil_id, coalesce(fu.nome, 'Sem funil') as funil_nome,
        c.vendedor_nome, c.ultima_mensagem_direcao, c.ultima_mensagem_em
    from clientes_crm c
    left join crm_funil_etapas e on e.funil_id = c.funil_id and e.nome = c.etapa
    left join crm_funis fu on fu.id = c.funil_id
    where c.deleted_at is null and c.mesclado_para is null
      and c.data_entrada >= timezone('UTC', p_inicio::timestamp)
      and c.data_entrada <  timezone('UTC', (p_fim + 1)::timestamp)
      and crm_telefone_valido(c.telefone)
      and (p_funil is null or c.funil_id = p_funil)
      and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
      and (p_etapa is null or c.etapa = p_etapa)
      and (nullif(btrim(coalesce(p_busca, '')), '') is null
           or c.nome ilike '%' || btrim(p_busca) || '%'
           or (nullif(crm_telefone_digitos(p_busca), '') is not null
               and crm_telefone_digitos(c.telefone) like '%' || crm_telefone_digitos(p_busca) || '%'))
),
filtrada as (
    select b.*, crm_lead_convertido(b.id, p_inicio, p_fim) as convertido
    from base b where p_fonte is null or b.fonte = p_fonte
),
pagina as (
    select f.*, count(*) over ()::bigint as total_registros from filtrada f
    order by f.data_entrada desc
    limit greatest(coalesce(p_limit, 200), 1) offset greatest(coalesce(p_offset, 0), 0)
)
select p.id, p.nome, p.telefone, p.email, p.data_entrada, p.origem, p.fonte,
    p.anuncio_id, p.anuncio_titulo, p.anuncio_app, p.campanha_origem,
    p.etapa, p.etapa_label, p.funil_id, p.funil_nome, p.vendedor_nome,
    p.ultima_mensagem_direcao, p.ultima_mensagem_em, p.convertido,
    coalesce(cl.classe, 'novo'), cl.dias_desde_ultimo, cl.desfecho_anterior, p.total_registros
from pagina p left join crm_lead_reentrada() cl on cl.id = p.id
order by p.data_entrada desc;
$function$;

CREATE OR REPLACE FUNCTION public.crm_leads_por_classe(p_ini date, p_fim date, p_classe text DEFAULT NULL::text, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[], p_limite integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with base as (
  select r.id, r.nome, r.telefone, r.vendedor_nome, r.etapa, r.data_entrada,
         r.ultima_mensagem_em, r.aguardando, r.funil_id,
         coalesce(cl.classe, 'novo') as classe, cl.dias_desde_ultimo, cl.desfecho_anterior
  from crm_leads_recebidos(p_ini, p_fim, p_vendedores, p_funil) r
  left join crm_lead_reentrada() cl on cl.id = r.id
),
filtrada as (
  select b.*, coalesce(f.nome, 'Sem funil') as funil_nome,
         coalesce(e.label, e.nome, b.etapa) as etapa_label
  from base b
  left join crm_funis f on f.id = b.funil_id
  left join crm_funil_etapas e on e.funil_id = b.funil_id and e.nome = b.etapa
  where p_classe is null or p_classe = 'todos' or b.classe = p_classe
)
select jsonb_build_object(
  'total', (select count(*)::int from filtrada),
  'leads', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'nome', nome, 'telefone', telefone, 'vendedor', vendedor_nome,
      'etapa', etapa_label, 'funil', funil_nome, 'data_entrada', data_entrada,
      'aguardando', aguardando, 'classe', classe,
      'dias_desde_ultimo', dias_desde_ultimo, 'desfecho_anterior', desfecho_anterior
    ) order by data_entrada desc), '[]'::jsonb)
    from (select * from filtrada order by data_entrada desc limit greatest(coalesce(p_limite, 300), 1)) x)
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_leads_recebidos(p_ini date, p_fim date, p_vendedores text[] DEFAULT NULL::text[], p_funil uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, nome text, telefone text, telefone_norm text, vendedor_id text, vendedor_nome text, funil_id uuid, etapa text, etapa_ordem integer, origem text, anuncio_id text, data_entrada timestamp with time zone, lead_chegou_em timestamp with time zone, primeira_resposta_em timestamp with time zone, ultima_mensagem_em timestamp with time zone, ultima_mensagem_direcao text, aguardando boolean)
 LANGUAGE sql
 STABLE
AS $function$
  select c.id, c.nome, c.telefone, c.telefone_norm,
         c.vendedor_id, coalesce(c.vendedor_nome, 'Sem vendedor'),
         c.funil_id, c.etapa,
         case when c.etapa = 'perdido' then 0 else coalesce(e.ordem, 999) end,
         c.origem, c.anuncio_id,
         c.data_entrada, c.lead_chegou_em, c.primeira_resposta_em,
         c.ultima_mensagem_em, c.ultima_mensagem_direcao,
         public.crm_lead_aguardando(c.ultima_mensagem_direcao)
  from public.clientes_crm c
  left join public.crm_funil_etapas e on e.funil_id = c.funil_id and e.nome = c.etapa
  where c.deleted_at is null
    and c.mesclado_para is null
    and public.crm_telefone_valido(c.telefone)
    and c.data_entrada >= p_ini::timestamp
    and c.data_entrada <  (p_fim + 1)::timestamp
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores))
    and (p_funil is null or c.funil_id = p_funil);
$function$;

CREATE OR REPLACE FUNCTION public.crm_leads_resumo(p_inicio date, p_fim date, p_funil uuid DEFAULT NULL::uuid, p_vendedores text[] DEFAULT NULL::text[], p_fonte text DEFAULT NULL::text, p_etapa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with todos as (
  select r.*, public.fn_dia_local(r.data_entrada) as dia,
         case
           when nullif(btrim(c.anuncio_app), '') is not null then 'Anuncio ' || lower(btrim(c.anuncio_app))
           when nullif(btrim(r.origem), '') is not null then btrim(r.origem)
           else 'Sem origem' end as fonte,
         c.anuncio_titulo, c.anuncio_app,
         public.fn_lead_prospectado(r.id) as prospectado
  from crm_leads_recebidos(p_inicio, p_fim, p_vendedores, p_funil) r
  join clientes_crm c on c.id = r.id
  where (p_etapa is null or r.etapa = p_etapa)
),
base as (select * from todos where not prospectado),
filtrada as (
  select b.*, crm_lead_convertido(b.id, p_inicio, p_fim) as convertido, cl.classe
  from base b
  left join crm_lead_reentrada() cl on cl.id = b.id
  where p_fonte is null or b.fonte = p_fonte
)
select jsonb_build_object(
  'kpis', (select jsonb_build_object(
      'total',               count(*)::int,
      'novos',               count(*) filter (where etapa_ordem = 1)::int,
      'em_atendimento',      count(*) filter (where etapa_ordem > 1 and etapa_ordem < 999)::int,
      'aguardando_resposta', count(*) filter (where aguardando)::int,
      'convertidos',         count(*) filter (where convertido)::int,
      'etapa_orfa',          count(*) filter (where etapa_ordem = 999)::int,
      'com_anuncio',         count(*) filter (where nullif(btrim(coalesce(anuncio_id, '')), '') is not null)::int,
      'novo',                count(*) filter (where classe = 'novo')::int,
      'remarketing',         count(*) filter (where classe = 'remarketing')::int,
      'duplicado',           count(*) filter (where classe = 'duplicado')::int
    ) from filtrada),
  'convertidos_ids', (select coalesce(jsonb_agg(id), '[]'::jsonb) from filtrada where convertido),
  'por_funil', (select coalesce(jsonb_agg(jsonb_build_object(
        'funil_id', funil_id, 'funil_nome', funil_nome, 'total', total, 'novos', novos,
        'em_atendimento', em_atendimento, 'aguardando_resposta', aguardando_resposta, 'convertidos', convertidos
      ) order by total desc), '[]'::jsonb)
      from (select f.funil_id, coalesce(fu.nome, 'Sem funil') as funil_nome,
                   count(*)::int as total,
                   count(*) filter (where f.etapa_ordem = 1)::int as novos,
                   count(*) filter (where f.etapa_ordem > 1 and f.etapa_ordem < 999)::int as em_atendimento,
                   count(*) filter (where f.aguardando)::int as aguardando_resposta,
                   count(*) filter (where f.convertido)::int as convertidos
            from filtrada f left join crm_funis fu on fu.id = f.funil_id group by 1, 2) pf),
  'por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'funil_id', funil_id, 'funil_nome', funil_nome, 'total', total) order by dia, funil_nome), '[]'::jsonb)
      from (select f.dia, f.funil_id, coalesce(fu.nome, 'Sem funil') as funil_nome, count(*)::int as total
            from filtrada f left join crm_funis fu on fu.id = f.funil_id group by 1, 2, 3) pd),
  'por_fonte', (select coalesce(jsonb_agg(jsonb_build_object('fonte', fonte, 'total', total) order by total desc), '[]'::jsonb)
      from (select fonte, count(*)::int as total from filtrada group by 1) pfo),
  'fontes_disponiveis', (select coalesce(jsonb_agg(jsonb_build_object('fonte', fonte, 'total', total) order by total desc), '[]'::jsonb)
      from (select fonte, count(*)::int as total from base group by 1) fd),
  'por_anuncio', (select coalesce(jsonb_agg(jsonb_build_object('anuncio_id', anuncio_id, 'anuncio_titulo', anuncio_titulo, 'anuncio_app', anuncio_app, 'total', total) order by total desc), '[]'::jsonb)
      from (select f.anuncio_id, f.anuncio_titulo, f.anuncio_app, count(*)::int as total
            from filtrada f where nullif(btrim(coalesce(f.anuncio_id, '')), '') is not null
            group by 1, 2, 3 order by count(*) desc limit 20) pa),
  'prospectados', (select count(*)::int from todos where prospectado),
  'sem_numero', crm_leads_sem_numero(p_inicio, p_fim, p_vendedores)
);
$function$;

CREATE OR REPLACE FUNCTION public.crm_leads_sem_numero(p_ini date, p_fim date, p_vendedores text[] DEFAULT NULL::text[])
 RETURNS bigint
 LANGUAGE sql
 STABLE
AS $function$
  select count(*) from public.clientes_crm c
  where c.deleted_at is null and c.mesclado_para is null
    and not public.crm_telefone_valido(c.telefone)
    and c.data_entrada >= p_ini::timestamp
    and c.data_entrada <  (p_fim + 1)::timestamp
    and (p_vendedores is null or c.vendedor_id = any(p_vendedores));
$function$;

CREATE OR REPLACE FUNCTION public.crm_mescla_autor()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    'SQL direto'
  );
$function$;

CREATE OR REPLACE FUNCTION public.crm_mescla_resumo(p_cliente_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with absorvidos as (
    select c.id, c.nome, c.mesclado_em,
           (select count(*) from public.crm_conversas k where k.cliente_crm_id = c.id) as conversas_que_sobraram
    from public.clientes_crm c where c.mesclado_para = p_cliente_id
  ),
  movidas as (
    select count(*) filter (where l.tabela = 'crm_conversas') as conversas_movidas,
           count(*) as linhas_movidas, max(l.mesclado_em) as ultimo,
           max(l.autor) as autor
    from public.crm_mescla_log l where l.sobrevivente = p_cliente_id
  ),
  ret as (
    select r.origem, r.criado_em, r.campos_carregados
    from public.crm_mescla_retrato r where r.sobrevivente = p_cliente_id
  ),
  nomes as (
    select distinct nome_campo from (
      select jsonb_array_elements_text(
               case when jsonb_typeof(e) = 'object' then e -> 'campos' else jsonb_build_array(e) end
             ) as nome_campo
      from ret, lateral jsonb_array_elements(coalesce(ret.campos_carregados, '[]'::jsonb)) e
    ) z where nome_campo is not null
  )
  select case
    when (select count(*) from absorvidos) = 0 and coalesce((select linhas_movidas from movidas),0) = 0
      then '{}'::jsonb
    else jsonb_build_object(
      'cards', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', a.id, 'nome', a.nome, 'em', a.mesclado_em,
                  'conversas_que_sobraram', a.conversas_que_sobraram) order by a.mesclado_em), '[]'::jsonb) from absorvidos a),
      'conversas_movidas', (select conversas_movidas from movidas),
      'linhas_movidas',    (select linhas_movidas from movidas),
      'em',                (select ultimo from movidas),
      'autor',             (select autor from movidas),
      'recuperacao_retroativa', exists (select 1 from ret where origem = 'recuperacao_retroativa'),
      'recuperado_em',     (select max(criado_em) from ret where origem = 'recuperacao_retroativa'),
      'campos_carregados', case when (select count(*) from ret) = 0 then null
                                else (select coalesce(jsonb_agg(nome_campo order by nome_campo), '[]'::jsonb) from nomes) end
    ) end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_mesclar_grupo(p_sobrevivente uuid, p_absorvidos uuid[])
 RETURNS jsonb
 LANGUAGE sql
AS $function$
  select public.crm_mesclar_grupo(p_sobrevivente, p_absorvidos, 'manual');
$function$;

CREATE OR REPLACE FUNCTION public.crm_mesclar_grupo(p_sobrevivente uuid, p_absorvidos uuid[], p_lote text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_funil uuid; v_norm text; v_ok int; n_conv int; n_vendas int; n_mov int := 0;
  v_recente record; v_retornos jsonb; v_etapa_atual text; v_etapa_final text;
  v_abs_txt text[] := (select array_agg(x::text) from unnest(p_absorvidos) x);
  v_autor text := public.crm_mescla_autor();
  alvos text[][] := array[
    ['vendas','cliente_crm_id','1'], ['dados_preenchidos','cliente_crm_id','1'],
    ['formulario_clientes','cliente_crm_id','1'], ['leads_diario','crm_cliente_id','1'],
    ['crm_conversas','cliente_crm_id','0'], ['crm_historico','cliente_id','0'],
    ['crm_eventos_jornada','cliente_id','0'], ['acoes_dia','cliente_id','0'],
    ['leads_distribuicao_log','cliente_id','0'], ['rfm_segmentos','cliente_id','0'],
    ['crm_conversa_analise','cliente_crm_id','0'], ['mkt_conversao_evento','cliente_crm_id','0'],
    ['inadimplencia_acordos','cliente_id','0'], ['inadimplencia_contatos','cliente_id','0'],
    ['inadimplencia_juridico','cliente_id','0'], ['inadimplencia_timeline','cliente_id','0']];
  i int; n_linhas int;
  v_sob record; v_par record; v_anu record; v_carregados jsonb := '[]'::jsonb;
begin
  select funil_id, telefone_norm, etapa into v_funil, v_norm, v_etapa_atual
  from clientes_crm where id = p_sobrevivente;
  if v_funil is null then raise exception 'sobrevivente % nao existe', p_sobrevivente; end if;
  if public.crm_numero_da_casa(v_norm) then raise exception 'numero da casa nao entra em mescla'; end if;

  select count(*) into v_ok from clientes_crm
  where id = any(p_absorvidos) and funil_id = v_funil and telefone_norm = v_norm
    and id <> p_sobrevivente and mesclado_para is null and deleted_at is null
    and coalesce(distinto_confirmado, false) = false;
  if v_ok <> coalesce(array_length(p_absorvidos, 1), 0) then
    raise exception 'absorvidos invalidos: % de % passaram na checagem', v_ok, coalesce(array_length(p_absorvidos,1),0);
  end if;

  insert into public.crm_mescla_retrato (lote, sobrevivente, retrato, autor, origem)
  select p_lote, p_sobrevivente, to_jsonb(c), v_autor, 'mescla'
  from clientes_crm c where c.id = p_sobrevivente;

  select coalesce(jsonb_agg(jsonb_build_object(
           'card', a.id, 'nome', a.nome, 'data_entrada', a.data_entrada, 'etapa', a.etapa,
           'comprou', exists (select 1 from vendas v where v.cliente_crm_id = a.id::text
                                and v.ativa is not false and v.deleted_at is null
                                and coalesce(v.excluida_contabilizacao, false) = false)
         ) order by a.data_entrada), '[]'::jsonb) into v_retornos
  from clientes_crm a where a.id = any(p_absorvidos);

  for i in 1 .. array_length(alvos, 1) loop
    -- tabela da camada de venda que nao existe aqui nao tem linha apontando para o card
    if to_regclass('public.' || alvos[i][1]) is null then continue; end if;
    if alvos[i][3] = '1' then
      execute format(
        'insert into crm_mescla_log (lote, sobrevivente, absorvido, tabela, coluna, registro_id, autor)
         select $1, $2, t.%1$I::uuid, %2$L, %3$L, t.id::text, $4 from %2$I t where t.%1$I = any($3)',
        alvos[i][2], alvos[i][1], alvos[i][2]) using p_lote, p_sobrevivente, v_abs_txt, v_autor;
      get diagnostics n_linhas = row_count; n_mov := n_mov + n_linhas;
      execute format('update %1$I set %2$I = $1::text where %2$I = any($2)', alvos[i][1], alvos[i][2])
        using p_sobrevivente, v_abs_txt;
    else
      execute format(
        'insert into crm_mescla_log (lote, sobrevivente, absorvido, tabela, coluna, registro_id, autor)
         select $1, $2, t.%1$I, %2$L, %3$L, t.id::text, $4 from %2$I t where t.%1$I = any($3)',
        alvos[i][2], alvos[i][1], alvos[i][2]) using p_lote, p_sobrevivente, p_absorvidos, v_autor;
      get diagnostics n_linhas = row_count; n_mov := n_mov + n_linhas;
      execute format('update %1$I set %2$I = $1 where %2$I = any($2)', alvos[i][1], alvos[i][2])
        using p_sobrevivente, p_absorvidos;
    end if;
  end loop;

  select id, etapa, vendedor_id, vendedor_nome, ultima_mensagem_em, ultima_mensagem_direcao
    into v_recente
  from clientes_crm where id = p_sobrevivente or id = any(p_absorvidos)
  order by coalesce(ultima_mensagem_em, data_entrada) desc, id asc limit 1;

  v_etapa_final := case when v_etapa_atual = 'fechado' then 'fechado' else v_recente.etapa end;

  update clientes_crm set
    etapa = v_etapa_final,
    vendedor_id = v_recente.vendedor_id, vendedor_nome = v_recente.vendedor_nome,
    ultima_mensagem_em = v_recente.ultima_mensagem_em,
    ultima_mensagem_direcao = v_recente.ultima_mensagem_direcao,
    data_entrada = least(data_entrada, (select min(data_entrada) from clientes_crm where id = any(p_absorvidos))),
    retornos = coalesce(retornos, '[]'::jsonb) || v_retornos
  where id = p_sobrevivente;

  select * into v_sob from clientes_crm where id = p_sobrevivente;

  if v_sob.lead_chegou_em is null and v_sob.primeira_resposta_em is null then
    select a.lead_chegou_em, a.primeira_resposta_em into v_par
    from clientes_crm a
    where a.id = any(p_absorvidos) and a.lead_chegou_em is not null
    order by a.lead_chegou_em limit 1;
    if found then
      update clientes_crm
         set lead_chegou_em = v_par.lead_chegou_em,
             primeira_resposta_em = v_par.primeira_resposta_em
       where id = p_sobrevivente;
      v_carregados := v_carregados || '["lead_chegou_em","primeira_resposta_em"]'::jsonb;
    end if;
  end if;

  if v_sob.anuncio_id is null and v_sob.ctwa_token is null then
    select a.anuncio_id, a.anuncio_titulo, a.anuncio_texto, a.anuncio_link,
           a.anuncio_app, a.ctwa_token, a.campanha_origem
      into v_anu
    from clientes_crm a
    where a.id = any(p_absorvidos)
      and (a.anuncio_id is not null or a.ctwa_token is not null)
    order by a.data_entrada limit 1;
    if found then
      update clientes_crm
         set anuncio_id = v_anu.anuncio_id, anuncio_titulo = v_anu.anuncio_titulo,
             anuncio_texto = v_anu.anuncio_texto, anuncio_link = v_anu.anuncio_link,
             anuncio_app = v_anu.anuncio_app, ctwa_token = v_anu.ctwa_token,
             campanha_origem = coalesce(campanha_origem, v_anu.campanha_origem)
       where id = p_sobrevivente;
      v_carregados := v_carregados
        || '["anuncio_id","anuncio_titulo","anuncio_texto","anuncio_link","anuncio_app","ctwa_token","campanha_origem"]'::jsonb;
    end if;
  end if;

  if v_sob.origem is null then
    update clientes_crm set origem = (select a.origem from clientes_crm a
      where a.id = any(p_absorvidos) and a.origem is not null order by a.data_entrada limit 1)
     where id = p_sobrevivente and (select count(*) from clientes_crm a
      where a.id = any(p_absorvidos) and a.origem is not null) > 0;
    if found then v_carregados := v_carregados || '["origem"]'::jsonb; end if;
  end if;
  if v_sob.cpf is null then
    update clientes_crm set cpf = (select a.cpf from clientes_crm a
      where a.id = any(p_absorvidos) and a.cpf is not null order by a.data_entrada limit 1)
     where id = p_sobrevivente and (select count(*) from clientes_crm a
      where a.id = any(p_absorvidos) and a.cpf is not null) > 0;
    if found then v_carregados := v_carregados || '["cpf"]'::jsonb; end if;
  end if;
  if v_sob.email is null then
    update clientes_crm set email = (select a.email from clientes_crm a
      where a.id = any(p_absorvidos) and a.email is not null order by a.data_entrada limit 1)
     where id = p_sobrevivente and (select count(*) from clientes_crm a
      where a.id = any(p_absorvidos) and a.email is not null) > 0;
    if found then v_carregados := v_carregados || '["email"]'::jsonb; end if;
  end if;
  if v_sob.profissao is null then
    update clientes_crm set profissao = (select a.profissao from clientes_crm a
      where a.id = any(p_absorvidos) and a.profissao is not null order by a.data_entrada limit 1)
     where id = p_sobrevivente and (select count(*) from clientes_crm a
      where a.id = any(p_absorvidos) and a.profissao is not null) > 0;
    if found then v_carregados := v_carregados || '["profissao"]'::jsonb; end if;
  end if;

  update public.crm_mescla_retrato
     set campos_carregados = v_carregados
   where sobrevivente = p_sobrevivente and lote = p_lote and origem = 'mescla'
     and criado_em = (select max(criado_em) from public.crm_mescla_retrato
                       where sobrevivente = p_sobrevivente and lote = p_lote and origem = 'mescla');

  update clientes_crm set mesclado_para = p_sobrevivente, mesclado_em = now() where id = any(p_absorvidos);

  select count(*) into n_conv from crm_conversas where cliente_crm_id = p_sobrevivente;
  select count(*) into n_vendas from vendas where cliente_crm_id = p_sobrevivente::text;
  return jsonb_build_object('sobrevivente', p_sobrevivente, 'absorvidos', array_length(p_absorvidos,1),
    'linhas_movidas', n_mov, 'etapa_antes', v_etapa_atual, 'etapa_final', v_etapa_final,
    'estado_veio_de', v_recente.id, 'conversas', n_conv, 'vendas', n_vendas,
    'autor', v_autor, 'campos_carregados', v_carregados);
end $function$;

CREATE OR REPLACE FUNCTION public.crm_numero_da_casa(p_norm text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select p_norm is not null and (
    exists (select 1 from public.vendedores_whatsapp vw
            where public.crm_telefone_normalizado(vw.numero_whatsapp) = p_norm)
    or exists (select 1 from public.crm_numeros_internos ni where ni.telefone_norm = p_norm)
  );
$function$;

CREATE OR REPLACE FUNCTION public.crm_origem_normalizada(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p is null then null
    when translate(lower(btrim(p)), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') like 'indicacao%'
      then 'Indicação'
    else p
  end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_telefone_valido(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select length(public.crm_telefone_digitos(p)) between 8 and 13;
$function$;

CREATE OR REPLACE FUNCTION public.crm_url_decode(p text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare res bytea := ''::bytea; i int := 1; n int; ch text;
begin
  if p is null then return null; end if;
  p := replace(p,'+',' ');
  n := length(p);
  while i <= n loop
    ch := substr(p,i,1);
    if ch='%' and i+2<=n and substr(p,i+1,2) ~ '^[0-9A-Fa-f]{2}$' then
      res := res || decode(substr(p,i+1,2),'hex'); i := i+3;
    else
      res := res || convert_to(ch,'utf8'); i := i+1;
    end if;
  end loop;
  return convert_from(res,'utf8');
end $function$;

CREATE OR REPLACE FUNCTION public.fn_crm_card_vivo_no_funil(p_telefone text, p_funil_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select c.id
  from public.clientes_crm c
  where c.funil_id = p_funil_id
    and c.deleted_at is null
    and c.mesclado_para is null
    and c.telefone_norm is not null
    and c.telefone_norm = public.crm_telefone_normalizado(p_telefone)
    and p_funil_id is not null
  order by c.created_at desc
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.fn_crm_origem_normalizar()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    new.origem := public.crm_origem_normalizada(new.origem);
    return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_dia_local(p_quando timestamp with time zone)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select (p_quando at time zone 'America/Sao_Paulo')::date;
$function$;

CREATE OR REPLACE FUNCTION public.fn_lead_prospectado(p_cliente_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (select lower(coalesce(cv.direcao, '')) = 'enviada'
       from public.crm_conversas cv
      where cv.cliente_crm_id = p_cliente_id
      order by cv.criada_em
      limit 1), false)
   and (select nullif(btrim(coalesce(c.anuncio_id, '')), '') is null
             and nullif(btrim(coalesce(c.ctwa_token, '')), '') is null
          from public.clientes_crm c where c.id = p_cliente_id);
$function$;

CREATE OR REPLACE FUNCTION public.marcar_data_venda()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.data_venda is null
     and (
       (new.etapa is distinct from old.etapa and lower(coalesce(new.etapa,'')) like '%fechad%')
       or (new.contrato_status is distinct from old.contrato_status
           and lower(coalesce(new.contrato_status,'')) in ('signed','assinado','pago'))
       or (coalesce(new.valor_pago,0) > 0 and coalesce(old.valor_pago,0) = 0)
     )
  then
    new.data_venda := now();
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mkt_anuncios_resumo(p_ini date, p_fim date, p_vendedores text[] DEFAULT NULL::text[], p_funil uuid DEFAULT NULL::uuid, p_agrupar text DEFAULT 'titulo'::text, p_com_dinheiro boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with leads as (
    select r.id, r.data_entrada, c.anuncio_id, c.anuncio_titulo, c.campanha_nome,
           nullif(btrim(coalesce(c.anuncio_id, '')), '') is not null as atribuido
    from crm_leads_recebidos(p_ini, p_fim, p_vendedores, p_funil) r
    join clientes_crm c on c.id = r.id
),
com_grupo as (
    select l.*,
        case
            when not l.atribuido then null
            when p_agrupar = 'campanha' and nullif(btrim(coalesce(l.campanha_nome, '')), '') is not null
                then 'campanha:' || mkt_titulo_chave(l.campanha_nome)
            else 'id:' || l.anuncio_id
        end as grupo,
        case
            when p_agrupar = 'campanha' and nullif(btrim(coalesce(l.campanha_nome, '')), '') is not null
                then l.campanha_nome
            else coalesce(nullif(btrim(l.anuncio_titulo), ''), 'Sem título')
        end as rotulo_original
    from leads l
),
vendas_dos_leads as (
    select g.id as lead_id, g.grupo, g.atribuido, v.id as venda_id, v.valor,
           (v.data_fechamento - g.data_entrada::date) as dias
    from com_grupo g
    join vendas v on v.cliente_crm_id = g.id::text
     and v.ativa is not false
     and v.deleted_at is null
     and coalesce(v.excluida_contabilizacao, false) = false
),
anuncios_do_grupo as (
    select distinct
        case when p_agrupar = 'campanha' and nullif(btrim(coalesce(c.campanha_nome, '')), '') is not null
             then 'campanha:' || mkt_titulo_chave(c.campanha_nome)
             else 'id:' || c.anuncio_id end as grupo,
        c.anuncio_id
    from clientes_crm c
    where nullif(btrim(coalesce(c.anuncio_id, '')), '') is not null
),
gasto_grupo as (
    select a.grupo,
           sum(g.gasto) as gasto,
           count(distinct g.anuncio_id) as anuncios_com_gasto
    from anuncios_do_grupo a
    join mkt_gasto_campanha_dia g on g.anuncio_id = a.anuncio_id
     and g.plataforma = 'meta'
     and g.dia between p_ini and p_fim
    group by a.grupo
),
grafias_base as (
    -- Rotulo do grupo: o titulo mais recente daquele anuncio. `grafias` conta
    -- as variacoes de titulo do MESMO id.
    select x.grupo,
           (array_agg(x.rotulo_original order by x.data_entrada desc nulls last))[1] as rotulo,
           count(distinct x.rotulo_original) as grafias,
           array_agg(distinct x.rotulo_original) as grafias_lista,
           max(x.anuncio_id) as anuncio_id
    from (
        select case when p_agrupar = 'campanha' and nullif(btrim(coalesce(c.campanha_nome, '')), '') is not null
                    then 'campanha:' || mkt_titulo_chave(c.campanha_nome)
                    else 'id:' || c.anuncio_id end as grupo,
               case when p_agrupar = 'campanha' and nullif(btrim(coalesce(c.campanha_nome, '')), '') is not null
                    then c.campanha_nome
                    else coalesce(nullif(btrim(c.anuncio_titulo), ''), 'Sem título') end as rotulo_original,
               c.anuncio_id, c.data_entrada
        from clientes_crm c
        where c.deleted_at is null
          and nullif(btrim(coalesce(c.anuncio_id, '')), '') is not null
    ) x
    group by x.grupo
),
por_grupo as (
    select g.grupo,
           count(distinct g.id) as leads,
           count(distinct g.anuncio_id) as anuncios
    from com_grupo g
    where g.atribuido
    group by g.grupo
),
vendas_grupo as (
    select grupo,
           count(*) as vendas,
           count(distinct lead_id) as leads_convertidos,
           sum(valor) as valor,
           percentile_cont(0.5) within group (order by dias) filter (where dias is not null) as dias_mediana
    from vendas_dos_leads
    where atribuido
    group by grupo
),
linhas as (
    select p.grupo, gb.rotulo, gb.grafias, gb.grafias_lista, gb.anuncio_id, p.leads, p.anuncios,
           coalesce(v.vendas, 0) as vendas,
           coalesce(v.leads_convertidos, 0) as leads_convertidos,
           v.valor, v.dias_mediana,
           gg.gasto, coalesce(gg.anuncios_com_gasto, 0) as anuncios_com_gasto
    from por_grupo p
    join grafias_base gb on gb.grupo = p.grupo
    left join vendas_grupo v on v.grupo = p.grupo
    left join gasto_grupo gg on gg.grupo = p.grupo
),
fora as (
    select
        count(*) filter (where c.mesclado_para is null and not crm_telefone_valido(c.telefone)
                          and length(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g')) > 13) as id_whatsapp,
        count(*) filter (where c.mesclado_para is null and not crm_telefone_valido(c.telefone)
                          and length(regexp_replace(coalesce(c.telefone, ''), '\D', '', 'g')) <= 13) as sem_numero,
        count(*) filter (where c.mesclado_para is not null) as mesclados
    from clientes_crm c
    where c.deleted_at is null
      and c.data_entrada >= p_ini::timestamp
      and c.data_entrada < (p_fim + 1)::timestamp
      and (p_vendedores is null or c.vendedor_id = any (p_vendedores))
      and (p_funil is null or c.funil_id = p_funil)
      and (c.mesclado_para is not null or not crm_telefone_valido(c.telefone))
)
select jsonb_build_object(
    'agrupado_por', case when p_agrupar = 'campanha' then 'campanha' else 'anuncio' end,
    'captura_inicio', mkt_captura_origem_inicio(),
    'periodo_antes_da_captura', p_ini < mkt_captura_origem_inicio(),
    'dinheiro_omitido', not coalesce(p_com_dinheiro, false),
    'gasto_conectado', exists (select 1 from mkt_gasto_campanha_dia g where g.plataforma = 'meta' and g.dia between p_ini and p_fim),
    'total', jsonb_build_object(
        'leads', (select count(*) from leads),
        'atribuidos', (select count(*) from leads where atribuido),
        'sem_atribuicao', (select count(*) from leads where not atribuido),
        'vendas_atribuidos', (select count(*) from vendas_dos_leads where atribuido),
        'vendas_sem_atribuicao', (select count(*) from vendas_dos_leads where not atribuido),
        'valor_atribuidos', case when p_com_dinheiro then (select sum(valor) from vendas_dos_leads where atribuido) end,
        'valor_sem_atribuicao', case when p_com_dinheiro then (select sum(valor) from vendas_dos_leads where not atribuido) end
    ),
    'fora_da_base', (select jsonb_build_object('id_whatsapp', id_whatsapp, 'sem_numero', sem_numero, 'mesclados', mesclados) from fora),
    'linhas', coalesce((
        select jsonb_agg(jsonb_build_object(
            'grupo', l.grupo,
            'anuncio_id', l.anuncio_id,
            'rotulo', l.rotulo,
            'grafias', l.grafias,
            'grafias_lista', to_jsonb(l.grafias_lista),
            'anuncios', l.anuncios,
            'leads', l.leads,
            'vendas', l.vendas,
            'leads_convertidos', l.leads_convertidos,
            'conversao_pct', round(100.0 * l.vendas / nullif(l.leads, 0), 1),
            'dias_mediana', round(l.dias_mediana::numeric, 1),
            'valor', case when p_com_dinheiro then l.valor end,
            'ticket', case when p_com_dinheiro then round(l.valor / nullif(l.vendas, 0), 2) end,
            'gasto', case when p_com_dinheiro then l.gasto end,
            'anuncios_com_gasto', case when p_com_dinheiro then l.anuncios_com_gasto end,
            'custo_por_lead', case when p_com_dinheiro then round(l.gasto / nullif(l.leads, 0), 2) end,
            'custo_por_venda', case when p_com_dinheiro then round(l.gasto / nullif(l.vendas, 0), 2) end
        ) order by l.vendas desc, l.leads desc, l.rotulo)
        from linhas l
    ), '[]'::jsonb)
);
$function$;

CREATE OR REPLACE FUNCTION public.mkt_captura_origem_inicio()
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$ select date '2026-08-01' $function$;

CREATE OR REPLACE FUNCTION public.mkt_sem_anuncio_por_origem(p_ini date, p_fim date, p_vendedores text[] DEFAULT NULL::text[], p_funil uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with leads as (
  select r.id, c.origem, c.fonte_lead, c.google_gclid, c.importado_de,
         nullif(btrim(coalesce(c.anuncio_id,'')),'') is not null as tem_anuncio,
         exists (select 1 from vendas v where v.cliente_crm_id = c.id::text
                   and v.ativa is not false and v.deleted_at is null
                   and coalesce(v.excluida_contabilizacao,false) = false) as tem_venda
  from crm_leads_recebidos(p_ini, p_fim, p_vendedores, p_funil) r
  join clientes_crm c on c.id = r.id
),
sem as (
  select *,
    case
      when lower(btrim(coalesce(origem,''))) = 'whatsapp' then 'canal'
      when nullif(btrim(coalesce(origem,'')),'') is not null then 'anotada'
      when nullif(btrim(coalesce(fonte_lead,'')),'') is not null then 'anotada'
      when google_gclid is not null then 'anotada'
      when importado_de is not null then 'anotada'
      else 'nenhuma' end as classe,
    case
      when lower(btrim(coalesce(origem,''))) = 'whatsapp' then 'WhatsApp (só o canal)'
      when nullif(btrim(coalesce(origem,'')),'') is not null then btrim(origem)
      when nullif(btrim(coalesce(fonte_lead,'')),'') is not null then btrim(fonte_lead)
      when google_gclid is not null then 'Google (gclid)'
      when importado_de is not null then 'Importado: ' || importado_de
      else 'Sem origem nenhuma' end as rotulo
  from leads where not tem_anuncio
)
select jsonb_build_object(
  'total_sem_anuncio', (select count(*) from sem),
  'vendas_sem_anuncio', (select count(*) filter (where tem_venda) from sem),
  'sem_origem_nenhuma', (select count(*) from sem where classe = 'nenhuma'),
  'vendas_sem_origem_nenhuma', (select count(*) filter (where tem_venda) from sem where classe = 'nenhuma'),
  'linhas', coalesce((
    select jsonb_agg(jsonb_build_object(
      'rotulo', x.rotulo, 'classe', x.classe, 'leads', x.leads, 'vendas', x.vendas,
      'conversao_pct', round(100.0 * x.vendas / nullif(x.leads,0), 1)
    ) order by x.vendas desc, x.leads desc, x.rotulo)
    from (select rotulo, classe, count(*) as leads, count(*) filter (where tem_venda) as vendas
          from sem group by rotulo, classe) x
  ), '[]'::jsonb)
);
$function$;

CREATE OR REPLACE FUNCTION public.mkt_titulo_chave(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select nullif(lower(btrim(regexp_replace(
        translate(replace(coalesce(p, ''), chr(65039), ''),
            'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
            'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'),
        '\s+', ' ', 'g'))), '')
$function$;

CREATE OR REPLACE FUNCTION public.proteger_delete_massa()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  qtd_recente INTEGER;
BEGIN
  SELECT COUNT(*) INTO qtd_recente
  FROM clientes_crm
  WHERE deleted_at IS NOT NULL
    AND deleted_at > NOW() - INTERVAL '60 seconds';

  IF qtd_recente > 50 THEN
    RAISE EXCEPTION 'PROTECAO: tentativa de deletar % registros em menos de 60s. Operacao bloqueada. Contate o admin.', qtd_recente;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_data_entrada_propaga()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.data_entrada IS DISTINCT FROM NEW.data_entrada THEN
        UPDATE crm_eventos_jornada
        SET created_at = NEW.data_entrada
        WHERE cliente_id = NEW.id
          AND tipo_evento = 'lead_criado';

        UPDATE leads_diario
        SET data = NEW.data_entrada::date
        WHERE crm_cliente_id = NEW.id::text;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_crm_conversas_extrai_referral()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.cliente_crm_id is not null and new.payload_raw is not null
     and (new.payload_raw->'message') ? 'referral' then
    begin
      perform public.crm_extrair_referral(new.cliente_crm_id, new.payload_raw->'message'->'referral', false);
    exception when others then
      insert into public.crm_entrada_falhas (origem, etapa, motivo, sqlstate, erro_detalhe, payload)
      values ('trigger', 'referral', 'crm_extrair_referral falhou', sqlstate, sqlerrm,
              jsonb_build_object('cliente_crm_id', new.cliente_crm_id, 'conversa_id', new.id));
    end;
  end if;
  return new;
end;
$function$;

-- Mescla e desmescla nao sao chamadas pela tela: rodam por SQL, por quem
-- administra. O EXECUTE e tirado de anon e authenticated.
revoke execute on function public.crm_desmesclar_grupo(p_sobrevivente uuid) from public, anon, authenticated;
revoke execute on function public.crm_mesclar_grupo(p_sobrevivente uuid, p_absorvidos uuid[]) from public, anon, authenticated;
revoke execute on function public.crm_mesclar_grupo(p_sobrevivente uuid, p_absorvidos uuid[], p_lote text) from public, anon, authenticated;

reset check_function_bodies;
