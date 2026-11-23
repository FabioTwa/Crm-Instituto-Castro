
-- 53 Marcacoes no grupo do WhatsApp e recado avulso (pedido do Fabio, 23/11/2026)
--
--  grupo_pendencias_marcar = numeros (com DDD; o 55 e opcional) marcados com @ em
--    toda mensagem da Jully no grupo, separados por virgula.
--  grupo_mensagem_avulsa = recado que sai UMA vez no grupo (das 8h as 20h, seg-sab),
--    com as mesmas marcacoes na frente; depois a chave volta a ficar vazia.
--
-- Idempotente: nao sobrescreve um valor ja configurado.

insert into public.crm_ia_config (chave, valor, descricao)
values
  ('grupo_pendencias_marcar', '5511954580790,5511963201355',
   'Numeros marcados com @ nas mensagens da Jully no grupo (SQL 53), separados por virgula.'),
  ('grupo_mensagem_avulsa', '',
   'Recado que sai uma vez no grupo, com as marcacoes (SQL 53). O sistema esvazia depois de enviar.')
on conflict (chave) do nothing;

select chave, valor from public.crm_ia_config where chave in ('grupo_pendencias_marcar', 'grupo_mensagem_avulsa');

-- ROLLBACK:
--   delete from public.crm_ia_config where chave in ('grupo_pendencias_marcar', 'grupo_mensagem_avulsa');
