-- 02 Tabelas do nucleo
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- Colunas, chave primaria, unicidade e CHECK. Chave estrangeira no 04,
-- indice no 05. clientes_crm tem tambem as colunas que descrevem venda (valor,
-- valor_pago, forma_pagamento...): o front seleciona essas colunas por nome, e
-- coluna que falta derruba a consulta.

create sequence if not exists public.crm_entrada_bruta_id_seq;

create sequence if not exists public.crm_mescla_log_id_seq;

create sequence if not exists public.crm_mescla_retrato_id_seq;

create table public.perfis_acesso (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nome text NOT NULL,
    descricao text,
    cor text DEFAULT '#9CA3AF'::text,
    is_admin boolean DEFAULT false NOT NULL,
    is_sistema boolean DEFAULT false NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    ordem integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT perfis_acesso_nome_key UNIQUE (nome),
    CONSTRAINT perfis_acesso_pkey PRIMARY KEY (id)
);

create table public.users (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text,
    email text,
    pw text DEFAULT 'supabase_auth'::text,
    role text DEFAULT 'operador'::text,
    ini text DEFAULT ''::text,
    photo_base64 text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'ativo'::text,
    perfil text DEFAULT 'Vendedor'::text,
    vendedor_responsavel_id text,
    vendedor_responsavel_nome text,
    telas_permitidas text DEFAULT '[]'::text,
    funil_padrao uuid,
    perfil_id uuid,
    vendedores_responsaveis_ids text[],
    fixo_mensal numeric(10,2) DEFAULT 0 NOT NULL,
    desligado_em date,
    remunerado boolean DEFAULT true NOT NULL,
    elegivel_score boolean DEFAULT false NOT NULL,
    cargo_exibicao text,
    exibe_alunos boolean DEFAULT true NOT NULL,
    produto_principal_id uuid,
    CONSTRAINT users_email_key UNIQUE (email),
    CONSTRAINT users_pkey PRIMARY KEY (id)
);

create table public.sistema_telas (
    id text NOT NULL,
    nome text NOT NULL,
    secao text NOT NULL,
    icone text DEFAULT ''::text,
    ordem integer DEFAULT 0,
    descricao text DEFAULT ''::text,
    ativa boolean DEFAULT true NOT NULL,
    is_nova boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sistema_telas_pkey PRIMARY KEY (id)
);

create table public.permissoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    perfil_id uuid NOT NULL,
    tela_chave text NOT NULL,
    pode_visualizar boolean DEFAULT false NOT NULL,
    pode_criar boolean DEFAULT false NOT NULL,
    pode_editar boolean DEFAULT false NOT NULL,
    pode_excluir boolean DEFAULT false NOT NULL,
    pode_exportar boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    escopos jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT permissoes_perfil_id_tela_chave_key UNIQUE (perfil_id, tela_chave),
    CONSTRAINT permissoes_pkey PRIMARY KEY (id)
);

create table public.perfil_permissoes (
    perfil text NOT NULL,
    telas_permitidas text DEFAULT '[]'::text,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT perfil_permissoes_pkey PRIMARY KEY (perfil)
);

create table public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_email text,
    acao text NOT NULL,
    tabela text,
    registro_id text,
    dados_antes jsonb,
    dados_depois jsonb,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);

create table public.audit_log_critico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tabela text NOT NULL,
    operacao text NOT NULL,
    registro_id text NOT NULL,
    user_id text,
    dados_antes jsonb,
    dados_depois jsonb,
    alterado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_critico_pkey PRIMARY KEY (id),
    CONSTRAINT audit_log_critico_operacao_check CHECK ((operacao = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text, 'SOFT_DELETE'::text, 'RESTORE'::text])))
);

create table public.crm_funis (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nome text NOT NULL,
    descricao text,
    criado_por text,
    ativo boolean DEFAULT true,
    ordem integer DEFAULT 1,
    usuarios_permitidos text DEFAULT '[]'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_funis_pkey PRIMARY KEY (id)
);

create table public.crm_funil_etapas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    funil_id uuid,
    nome text NOT NULL,
    label text,
    cor text DEFAULT '#3B82F6'::text,
    ordem integer DEFAULT 1,
    CONSTRAINT crm_funil_etapas_pkey PRIMARY KEY (id)
);

create table public.vendedores_whatsapp (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendedor_id text NOT NULL,
    vendedor_nome text,
    numero_whatsapp text NOT NULL,
    zapi_instancia text,
    zapi_token text,
    ativo boolean DEFAULT true NOT NULL,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    funil_id uuid,
    meta_phone_id text,
    CONSTRAINT vendedores_whatsapp_pkey PRIMARY KEY (id)
);

create table public.clientes_crm (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    nome text NOT NULL,
    telefone text,
    email text,
    cpf text,
    profissao text,
    origem text,
    observacoes text,
    etapa text DEFAULT 'cliente_novo'::text NOT NULL,
    vendedor_id text,
    vendedor_nome text,
    data_entrada timestamp with time zone DEFAULT now(),
    importado_de text,
    pipeline_id uuid,
    valor numeric DEFAULT 0,
    valor_pago numeric DEFAULT 0,
    contrato_status text,
    forma_pagamento text,
    pgto_conciliado boolean DEFAULT false,
    parcelas integer,
    valor_parcela numeric,
    motivo_perda text,
    funil_id uuid,
    lead_score integer,
    lead_score_atualizado_em timestamp with time zone,
    fonte_lead text,
    sla_status text DEFAULT 'ok'::text,
    deleted_at timestamp with time zone,
    deleted_by_user_id text,
    delete_reason text,
    campanha_origem text,
    numero_whatsapp text,
    lead_chegou_em timestamp with time zone,
    primeira_resposta_em timestamp with time zone,
    ultima_mensagem_em timestamp with time zone,
    ultima_mensagem_direcao text,
    chat_lid text,
    ctwa_token text,
    campanha_nome text,
    anuncio_id text,
    anuncio_titulo text,
    anuncio_texto text,
    anuncio_link text,
    anuncio_app text,
    data_venda timestamp with time zone,
    ordem_espera timestamp with time zone GENERATED ALWAYS AS (CASE
    WHEN (ultima_mensagem_direcao = 'recebida'::text) THEN ultima_mensagem_em
    ELSE NULL::timestamp with time zone
END) STORED,
    telefone_norm text GENERATED ALWAYS AS (crm_telefone_normalizado(telefone)) STORED,
    google_campanha_id text,
    google_gclid text,
    mesclado_para uuid,
    mesclado_em timestamp with time zone,
    retornos jsonb,
    distinto_confirmado boolean DEFAULT false NOT NULL,
    distinto_motivo text,
    indicacao_vendedor_id text,
    indicado_por_tipo text,
    indicado_por_pessoa_id text,
    indicado_por_nome text,
    qualificacao smallint,
    anuncio_source_type text,
    anuncio_media_type text,
    anuncio_image_url text,
    anuncio_video_url text,
    anuncio_thumbnail_url text,
    anuncio_welcome_message text,
    anuncio_referral_extraido_em timestamp with time zone,
    CONSTRAINT clientes_crm_pkey PRIMARY KEY (id),
    CONSTRAINT chk_crm_indicado_por_completo CHECK ((((indicado_por_tipo IS NULL) AND (indicado_por_pessoa_id IS NULL) AND (indicado_por_nome IS NULL)) OR ((indicado_por_tipo IS NOT NULL) AND (indicado_por_pessoa_id IS NOT NULL) AND (indicado_por_nome IS NOT NULL)))),
    CONSTRAINT chk_crm_indicado_por_tipo CHECK (((indicado_por_tipo IS NULL) OR (indicado_por_tipo = ANY (ARRAY['aluno'::text, 'professor'::text])))),
    CONSTRAINT chk_crm_indicador_diferente_vendedor CHECK (((indicacao_vendedor_id IS NULL) OR (indicacao_vendedor_id <> vendedor_id))),
    CONSTRAINT chk_crm_qualificacao_0_5 CHECK (((qualificacao IS NULL) OR ((qualificacao >= 0) AND (qualificacao <= 5)))),
    CONSTRAINT clientes_crm_sla_status_check CHECK ((sla_status = ANY (ARRAY['ok'::text, 'amarelo'::text, 'vermelho'::text])))
);

create table public.crm_historico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    cliente_id uuid,
    etapa_anterior text,
    etapa_nova text,
    usuario_nome text,
    descricao text,
    tipo text DEFAULT 'etapa'::text,
    CONSTRAINT crm_historico_pkey PRIMARY KEY (id)
);

create table public.crm_eventos_jornada (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    funil_id uuid,
    vendedor_id text,
    tipo_evento text NOT NULL,
    etapa_origem text,
    etapa_destino text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    origem text DEFAULT 'realtime'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT crm_eventos_jornada_pkey PRIMARY KEY (id),
    CONSTRAINT crm_eventos_jornada_origem_check CHECK ((origem = ANY (ARRAY['realtime'::text, 'retroativo'::text]))),
    CONSTRAINT crm_eventos_jornada_tipo_evento_check CHECK ((tipo_evento = ANY (ARRAY['lead_criado'::text, 'etapa_alterada'::text, 'link_gerado'::text, 'dados_preenchidos'::text, 'contrato_assinado'::text, 'pagamento_confirmado'::text])))
);

create table public.crm_conversas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_crm_id uuid,
    vendedor_id text,
    numero_lead text,
    direcao text NOT NULL,
    autor text,
    mensagem text,
    tipo text DEFAULT 'texto'::text,
    zapi_message_id text,
    criada_em timestamp with time zone DEFAULT now() NOT NULL,
    payload_raw jsonb,
    exibicao text GENERATED ALWAYS AS (crm_mensagem_exibicao(mensagem, tipo, payload_raw)) STORED,
    CONSTRAINT crm_conversas_pkey PRIMARY KEY (id)
);

create table public.crm_conversas_repetidas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    origem text NOT NULL,
    zapi_message_id text NOT NULL,
    vendedor_id text,
    cliente_crm_id uuid,
    tipo_existente text,
    tipo_novo text,
    atualizou_placeholder boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_conversas_repetidas_pkey PRIMARY KEY (id)
);
comment on table public.crm_conversas_repetidas is 'Copia de mensagem reconhecida e nao gravada pelos webhooks (mesmo zapi_message_id, mesma instancia). Contador da trava crm_conversa_unica_por_instancia.';

create table public.crm_entrada_bruta (
    id bigint DEFAULT nextval('crm_entrada_bruta_id_seq'::regclass) NOT NULL,
    chegou_em timestamp with time zone DEFAULT now() NOT NULL,
    origem text NOT NULL,
    envelope jsonb NOT NULL,
    estado text DEFAULT 'pendente'::text NOT NULL,
    tentativas integer DEFAULT 0 NOT NULL,
    processada_em timestamp with time zone,
    motivo text,
    CONSTRAINT crm_entrada_bruta_pkey PRIMARY KEY (id),
    CONSTRAINT crm_entrada_bruta_estado_check CHECK ((estado = ANY (ARRAY['pendente'::text, 'processada'::text, 'falhou'::text]))),
    CONSTRAINT crm_entrada_bruta_origem_check CHECK ((origem = ANY (ARRAY['meta'::text, 'zapi'::text])))
);
comment on table public.crm_entrada_bruta is 'Envelope cru do webhook, como chegou, antes de qualquer interpretacao. Gravado ANTES do ack: se esta gravacao falhar, o webhook nao devolve sucesso, porque so nesse caso a mensagem realmente nao entrou. O processamento continua no waitUntil e marca estado aqui.';

create table public.crm_entrada_falhas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    origem text NOT NULL,
    etapa text NOT NULL,
    telefone text,
    funil_id uuid,
    vendedor_id text,
    motivo text NOT NULL,
    sqlstate text,
    erro_detalhe text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    telefone_norm text GENERATED ALWAYS AS (crm_telefone_normalizado(telefone)) STORED,
    CONSTRAINT crm_entrada_falhas_pkey PRIMARY KEY (id)
);
comment on table public.crm_entrada_falhas is 'Falha de escrita na porta de entrada dos leads (webhooks e importacoes). Uma linha por mensagem ou registro que nao conseguiu virar card ou conversa. Escrita fora da transacao que falhou, para sobreviver a ela.';

create table public.crm_mescla_log (
    id bigint DEFAULT nextval('crm_mescla_log_id_seq'::regclass) NOT NULL,
    lote text NOT NULL,
    sobrevivente uuid NOT NULL,
    absorvido uuid NOT NULL,
    tabela text NOT NULL,
    coluna text NOT NULL,
    registro_id text NOT NULL,
    mesclado_em timestamp with time zone DEFAULT now() NOT NULL,
    autor text,
    CONSTRAINT crm_mescla_log_pkey PRIMARY KEY (id)
);
comment on table public.crm_mescla_log is 'Toda linha repontada por crm_mesclar_grupo. E o que torna crm_desmesclar_grupo exato.';

create table public.crm_mescla_retrato (
    id bigint DEFAULT nextval('crm_mescla_retrato_id_seq'::regclass) NOT NULL,
    lote text NOT NULL,
    sobrevivente uuid NOT NULL,
    retrato jsonb NOT NULL,
    campos_carregados jsonb DEFAULT '[]'::jsonb NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    autor text,
    origem text DEFAULT 'mescla'::text NOT NULL,
    CONSTRAINT crm_mescla_retrato_pkey PRIMARY KEY (id),
    CONSTRAINT crm_mescla_retrato_origem_check CHECK ((origem = ANY (ARRAY['mescla'::text, 'recuperacao_retroativa'::text])))
);
comment on table public.crm_mescla_retrato is 'Estado inteiro do card sobrevivente ANTES da mescla, e quais campos foram carregados do absorvido. crm_desmesclar_grupo restaura daqui. Sem isto a volta nunca devolvia etapa, vendedor, ultima mensagem e data de entrada.';

create table public.crm_numeros_internos (
    telefone_norm text NOT NULL,
    motivo text NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_numeros_internos_pkey PRIMARY KEY (telefone_norm)
);
comment on table public.crm_numeros_internos is 'Numeros internos que nunca viram card de lead nem entram em conta. Complementa vendedores_whatsapp; consulte sempre por crm_numero_da_casa().';

create table public.acoes_dia (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    vendedor_id text NOT NULL,
    tipo text NOT NULL,
    titulo text NOT NULL,
    descricao text,
    data_prevista timestamp with time zone NOT NULL,
    concluida boolean DEFAULT false NOT NULL,
    data_conclusao timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT acoes_dia_pkey PRIMARY KEY (id),
    CONSTRAINT acoes_dia_tipo_check CHECK ((tipo = ANY (ARRAY['follow_up'::text, 'ligacao'::text, 'reuniao'::text, 'envio_proposta'::text, 'cobranca'::text, 'adiar'::text])))
);

create table public.leads_distribuicao_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_id uuid NOT NULL,
    vendedor_anterior_id text,
    vendedor_novo_id text,
    motivo text,
    feito_por_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT leads_distribuicao_log_pkey PRIMARY KEY (id)
);

create table public.leads_diario (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    data date DEFAULT CURRENT_DATE NOT NULL,
    nome text NOT NULL,
    telefone text,
    email text,
    fonte text,
    campanha text,
    canal text,
    gestor_trafego text,
    crm_cliente_id text,
    status text DEFAULT 'novo'::text,
    registrado_por text,
    vendedor_id text,
    vendedor_nome text,
    observacoes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT leads_diario_pkey PRIMARY KEY (id),
    CONSTRAINT leads_diario_status_check CHECK ((status = ANY (ARRAY['novo'::text, 'contatado'::text, 'qualificado'::text, 'descartado'::text, 'convertido'::text])))
);

create table public.mkt_gasto_campanha_dia (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plataforma text NOT NULL,
    conta_id text,
    campanha_id text NOT NULL,
    campanha_nome text,
    conjunto_id text,
    conjunto_nome text,
    anuncio_id text DEFAULT ''::text NOT NULL,
    anuncio_nome text,
    dia date NOT NULL,
    moeda text DEFAULT 'BRL'::text NOT NULL,
    gasto numeric(14,2) DEFAULT 0 NOT NULL,
    impressoes bigint DEFAULT 0 NOT NULL,
    cliques bigint DEFAULT 0 NOT NULL,
    leads_plataforma integer DEFAULT 0 NOT NULL,
    origem_importacao text DEFAULT 'api'::text NOT NULL,
    importado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mkt_gasto_campanha_dia_plataforma_campanha_id_anuncio_id_di_key UNIQUE (plataforma, campanha_id, anuncio_id, dia),
    CONSTRAINT mkt_gasto_campanha_dia_pkey PRIMARY KEY (id),
    CONSTRAINT mkt_gasto_campanha_dia_plataforma_check CHECK ((plataforma = ANY (ARRAY['meta'::text, 'google'::text])))
);
comment on table public.mkt_gasto_campanha_dia is 'Gasto/impressoes/cliques por plataforma, campanha, anuncio e dia. Vazia ate as credenciais da Meta e do Google chegarem. Chave de casamento com os cards: anuncio_id.';

create table public.jornada_metas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chave text NOT NULL,
    valor numeric NOT NULL,
    valor_texto text,
    descricao text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jornada_metas_chave_key UNIQUE (chave),
    CONSTRAINT jornada_metas_pkey PRIMARY KEY (id)
);

create table public.crm_ia_config (
    chave text NOT NULL,
    valor text NOT NULL,
    descricao text,
    CONSTRAINT crm_ia_config_pkey PRIMARY KEY (chave)
);

create table public.crm_conversa_analise (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cliente_crm_id uuid NOT NULL,
    analisada_em timestamp with time zone DEFAULT now() NOT NULL,
    modelo text NOT NULL,
    resultado jsonb NOT NULL,
    custo_tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
    ultima_mensagem_em timestamp with time zone,
    lote_id text,
    origem text DEFAULT 'lote'::text NOT NULL,
    CONSTRAINT crm_conversa_analise_pkey PRIMARY KEY (id),
    CONSTRAINT crm_conversa_analise_origem_check CHECK ((origem = ANY (ARRAY['lote'::text, 'sob_demanda'::text])))
);
comment on table public.crm_conversa_analise is 'Resultado da analise de IA por conversa. resultado: temperatura, objecoes, desejo_real, curso_adequado, bate_com_oferta, deixou_passar, sugestao_argumento, resumo. custo_tokens: {entrada, saida, custo_usd}.';

alter sequence public.crm_entrada_bruta_id_seq owned by public.crm_entrada_bruta.id;
alter sequence public.crm_mescla_log_id_seq owned by public.crm_mescla_log.id;
alter sequence public.crm_mescla_retrato_id_seq owned by public.crm_mescla_retrato.id;
