-- 42 A Jully nao informa valores pelo WhatsApp (retorno do Instituto, 28/10/2026).
--
-- Decisao do Instituto: nenhum valor, preco, parcelamento ou forma de
-- pagamento sai pelo WhatsApp; os valores sao conversados pessoalmente.
-- O prompt e a pos-validacao da function ic-ia-pre-atendimento ja seguem isso.
-- Aqui so desativamos os 3 exemplos de conversa que ensinavam a IA a falar
-- de preco ou parcelamento (IC03, IC14, IC18). Nada e apagado: os exemplos
-- ficam guardados com ativo = false.
--
-- Idempotente. ROLLBACK no fim.

update public.ia_exemplos_conversa
   set ativo = false
 where id in (
   '04b2263e-fd0a-498e-8f85-4f920a9f3151', -- IC03 lead ja usa medicacao e pergunta valor
   'd9807970-8b85-49b9-b30a-afd41fadc169', -- IC14 valor da consulta com o cirurgiao e objecao de preco
   'a58a23fb-9197-4ef1-8d11-3b50d4cc6bf5'  -- IC18 valor da consulta com o cirurgiao
 )
   and ativo = true;

-- Conferencia: deve voltar 0 linhas.
select id, titulo
  from public.ia_exemplos_conversa
 where ativo
   and resposta_ideal ~* 'r\$\s*\d|\d+\s*reais|parcel|pix|cart[aã]o|boleto';

-- ROLLBACK (reativa os 3 exemplos):
-- update public.ia_exemplos_conversa set ativo = true
--  where id in ('04b2263e-fd0a-498e-8f85-4f920a9f3151',
--               'd9807970-8b85-49b9-b30a-afd41fadc169',
--               'a58a23fb-9197-4ef1-8d11-3b50d4cc6bf5');
