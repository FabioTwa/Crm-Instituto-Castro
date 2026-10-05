-- 00 Extensoes
-- Esquema base do IC CRM (Instituto Castro). Sem nenhum dado.
-- pg_trgm: busca por nome e telefone (indices gin_trgm_ops). pg_cron e pg_net
-- ficam no arquivo 11, que e o unico que precisa deles.

create extension if not exists pg_trgm;
