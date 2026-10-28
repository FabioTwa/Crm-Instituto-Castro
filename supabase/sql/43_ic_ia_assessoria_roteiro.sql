-- 43 Exemplo IC02 (interesse na Assessoria) no roteiro da equipe do Instituto
-- (retorno de 28/10/2026), no tom leve da Jully: valoriza a decisao, explica a
-- Assessoria e pergunta sobre tratamento anterior e nutricionista ANTES de
-- convidar para vir. Antes o exemplo pulava direto para o dia e horario.
--
-- Idempotente. ROLLBACK no fim.

update public.ia_exemplos_conversa
   set resposta_ideal =
'Oi, tudo bem? Que bom que você se interessou pela nossa *Assessoria em Emagrecimento*! Buscar acompanhamento profissional é um passo importante pra cuidar da saúde com segurança.

É um programa com acompanhamento médico e nutricional. Na consulta, o médico avalia as suas necessidades e indica o tratamento mais adequado pra você.

Me conta, você já fez algum tratamento pra emagrecer? E hoje faz acompanhamento com nutricionista?'
 where titulo like 'IC02 %';

-- Conferencia: deve voltar 1 linha com o texto novo.
select titulo, resposta_ideal from public.ia_exemplos_conversa where titulo like 'IC02 %';

-- ROLLBACK (texto anterior, do SQL 40):
-- update public.ia_exemplos_conversa set resposta_ideal =
-- 'Oi, tudo bem? Que bom que você se interessou pela nossa *Assessoria em Emagrecimento* 
--
-- É um acompanhamento médico individual, com apoio nutricional, pensado pro seu objetivo.
--
-- O primeiro passo é uma consulta de avaliação com o nosso especialista, que conhece o seu histórico e monta o plano com você. Qual dia e horário ficam melhor pra você?'
--  where titulo like 'IC02 %';
