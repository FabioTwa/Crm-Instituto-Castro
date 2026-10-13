-- 29 Fase de teste da IA de pre-atendimento.
--
-- Duas chaves novas em crm_ia_config (lidas por _shared/ia-teste.ts):
--   modo_sombra   'true'  = a IA roda tudo mas nao envia nada ao lead; a resposta
--                           que teria saido fica em ia_decisoes_log.detalhe.resposta.
--                 'false' = a IA envia (se a flag envio_whatsapp_cloud_api tambem
--                           estiver ligada). A equipe continua enviando normalmente
--                           em qualquer caso.
--   numeros_teste telefones separados por virgula. Preenchida = a IA so atende
--                 esses numeros (celulares da equipe) e ignora os demais leads.
--                 Vazia = atende todos.
--
-- Aditivo: so insere configuracao. Nenhum dado existente muda.
-- Idempotente. Pode rodar de novo.
-- ROLLBACK (no fim do arquivo).

insert into public.crm_ia_config (chave, valor, descricao) values
  ('modo_sombra',   'true', 'IC: true = a IA nao envia nada ao lead (so registra a resposta em ia_decisoes_log)'),
  ('numeros_teste', '',     'IC: telefones separados por virgula; preenchida = a IA so atende esses numeros')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- delete from public.crm_ia_config where chave in ('modo_sombra', 'numeros_teste');
