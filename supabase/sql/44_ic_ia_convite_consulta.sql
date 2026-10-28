-- 44 A Jully convida para CONSULTA com um especialista (padrao pedido pelo
-- Instituto em 28/10/2026), e nao mais para "vir conhecer a clinica".
-- Ajusta os 2 exemplos ativos que ainda falavam em visita:
--   IC15 (parcelar sem cartao): fala de forma de pagamento, que a Jully nao
--        trata mais pelo WhatsApp (SQL 42) -> desativado, sem apagar.
--   IC24 (cancelamento por medo): mesmo texto, trocando visita por consulta.
--
-- Idempotente. ROLLBACK no fim.

update public.ia_exemplos_conversa
   set ativo = false
 where titulo like 'IC15 %' and ativo = true;

update public.ia_exemplos_conversa
   set resposta_ideal =
'Imagino, e é super normal sentir medo. Muita gente chega aqui assim, e é muito bom que você me contou.

A consulta é justamente pra você conversar com calma com um dos nossos especialistas e tirar todas as dúvidas pessoalmente. Nada é decidido ali, você segue no seu tempo.

Que tal manter o seu horário? Se preferir, a gente troca o dia.'
 where titulo like 'IC24 %';

-- Conferencia: deve voltar 0 linhas.
select titulo from public.ia_exemplos_conversa
 where ativo and (resposta_ideal ilike '%conhecer%' or resposta_ideal ilike '%visita%');

-- ROLLBACK:
-- update public.ia_exemplos_conversa set ativo = true where titulo like 'IC15 %';
-- update public.ia_exemplos_conversa set resposta_ideal =
-- 'Imagino, e é super normal sentir medo. Muita gente chega aqui assim, e é muito bom que você me contou.
--
-- A visita é justamente pra você conhecer a clínica com calma e conversar pessoalmente com um dos nossos especialistas, tirar todas as dúvidas. Nada é decidido ali, você segue no seu tempo.
--
-- Que tal manter o seu horário? Se preferir, a gente troca o dia.'
--  where titulo like 'IC24 %';
