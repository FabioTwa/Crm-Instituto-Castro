-- 24 Limites de tamanho de texto (o front usa os mesmos números em maxlength)
-- ============================================================================
-- As colunas são `text` sem limite: colar um texto enorme num nome entrava no banco e quebrava telas.
-- O front limita (maxlength), o banco repete: quem grava por CSV, API ou webhook também respeita.
--
--   clientes_crm.nome        <= 200      clientes_crm.profissao   <= 100
--   clientes_crm.observacoes <= 5000     crm_funis.nome           <= 100
--
-- NOT VALID: vale para toda linha nova ou alterada; não reprova linhas antigas na hora de criar a
-- constraint. Para conferir o legado antes de validar:
--   select id, length(nome) from clientes_crm where length(nome) > 200;
-- e, com o legado limpo:  alter table public.clientes_crm validate constraint ic_clientes_nome_tam;
--
-- ROLLBACK no rodapé.

alter table public.clientes_crm drop constraint if exists ic_clientes_nome_tam;
alter table public.clientes_crm add constraint ic_clientes_nome_tam check (nome is null or length(nome) <= 200) not valid;

alter table public.clientes_crm drop constraint if exists ic_clientes_profissao_tam;
alter table public.clientes_crm add constraint ic_clientes_profissao_tam check (profissao is null or length(profissao) <= 100) not valid;

alter table public.clientes_crm drop constraint if exists ic_clientes_observacoes_tam;
alter table public.clientes_crm add constraint ic_clientes_observacoes_tam check (observacoes is null or length(observacoes) <= 5000) not valid;

alter table public.crm_funis drop constraint if exists ic_funis_nome_tam;
alter table public.crm_funis add constraint ic_funis_nome_tam check (nome is null or length(nome) <= 100) not valid;

-- ROLLBACK:
-- alter table public.clientes_crm drop constraint if exists ic_clientes_nome_tam;
-- alter table public.clientes_crm drop constraint if exists ic_clientes_profissao_tam;
-- alter table public.clientes_crm drop constraint if exists ic_clientes_observacoes_tam;
-- alter table public.crm_funis drop constraint if exists ic_funis_nome_tam;
