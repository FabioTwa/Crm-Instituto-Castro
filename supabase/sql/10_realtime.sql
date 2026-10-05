-- 10 Realtime
-- Publicacao do Realtime (pg_publication_tables).
--
-- O Kanban e a conversa do card se atualizam ao vivo por estas duas tabelas.
-- crm_conversas entra SEM payload_raw de proposito: a coluna guarda o JSON cru
-- da Meta (ate 293 KB numa linha) e derrubava o canal no navegador. A lista de
-- colunas abaixo evita isso. Coluna gerada (exibicao) nao entra em
-- publicacao: o Postgres recusa.
-- No Supabase a publicacao supabase_realtime ja existe; fora dele, crie antes:
--   create publication supabase_realtime;

alter publication supabase_realtime add table public.clientes_crm;
alter publication supabase_realtime add table public.crm_conversas
  (id, cliente_crm_id, vendedor_id, numero_lead, direcao, autor, mensagem, tipo, zapi_message_id, criada_em);
