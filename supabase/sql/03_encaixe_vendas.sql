-- 03 ENCAIXE: a tabela vendas, reduzida ao que o CRM le
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- 
-- Esta e a costura entre o CRM e qualquer camada de venda. Catorze funcoes do
-- nucleo (conversao, reentrada, Acoes do Dia, anuncios, jornada, mescla) e tres
-- telas do front perguntam a mesma coisa a esta tabela, sempre com o mesmo
-- recorte:
--
--     cliente_crm_id = <card>  and ativa is not false  and deleted_at is null
--     and coalesce(excluida_contabilizacao, false) = false
--
-- e, quando precisam de quando e quanto, leem data_fechamento e valor.
--
-- Quer dizer: "este card foi ganho", "quando" e "quanto valeu". So isso.
--
-- O sistema novo tem tres caminhos:
--   a) nao tem venda: deixa a tabela vazia. Conversao fica zero, Acoes do Dia
--      nao separa quem ja comprou, e nada quebra.
--   b) tem venda propria: escreve UMA linha aqui por venda ganha, com as
--      colunas abaixo, ou troca esta tabela por uma VIEW com o mesmo nome e
--      as mesmas colunas lendo a tabela de venda dele.
--   c) ja existe uma tabela de vendas completa: ela ja cumpre isto.
--
-- As colunas sao as da tabela real (tipo e default conferidos no catalogo).
-- dados_preenchidos_id fica porque o front consulta por ela ao
-- excluir um card; sem a coluna a consulta erra (e e ignorada).

create table public.vendas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    cliente_crm_id text,
    dados_preenchidos_id text,
    valor numeric,
    valor_pago numeric DEFAULT 0,
    data_fechamento date,
    ativa boolean DEFAULT true,
    deleted_at timestamp with time zone,
    excluida_contabilizacao boolean DEFAULT false NOT NULL,
    CONSTRAINT vendas_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_vendas_deleted ON public.vendas USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);
CREATE INDEX idx_vendas_cliente_crm_id ON public.vendas USING btree (cliente_crm_id) WHERE (cliente_crm_id IS NOT NULL);

comment on table public.vendas is 'ENCAIXE do CRM: uma linha por venda ganha de um card. Ver 03_encaixe_vendas.sql';
