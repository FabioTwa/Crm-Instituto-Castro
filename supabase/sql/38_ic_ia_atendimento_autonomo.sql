-- 38 Atendimento 100% autonomo da IA (decisao do Fabio, 22/10/2026).
--
-- Nao existe atendente: a IA nunca diz que vai passar para a equipe, chamar
-- alguem ou que alguem vai confirmar. O codigo (ic-ia-pre-atendimento) ja
-- mudou; aqui so os exemplos da IA, que ainda falavam em "nossa equipe":
--   IC08 e IC16   reserva sem "a equipe te manda a confirmacao"
--   IC15          boleto: a pessoa ve as formas de pagamento na visita
--   IC23-IC25     cancelamento: acolhe e pergunta o motivo, responde ao medo e
--                 convida a manter, e respeita quem continua decidido
--
-- Sem dado de paciente: textos montados para o exemplo.
-- Idempotente. ROLLBACK no fim do arquivo.

update public.ia_exemplos_conversa e
set resposta_ideal = v.resposta_ideal
from (values
  ('IC08 lead quer horario mais tarde por vir de longe',
'Claro! Prontinho, deixei reservado o dia 05/11 (quinta-feira) às 11:00. Te esperamos aqui na Av. Paes de Barros, 1378, na Mooca 😊'),

  ('IC15 parcelar sem cartao',
'Entendi! As outras formas de pagamento você vê certinho aqui com a gente, na visita. Que tal vir conhecer a clínica e conversar com um dos nossos especialistas?'),

  ('IC16 lead aceita dia e periodo',
'Perfeito! Deixei reservado o dia 22/10 às 11:00 ✨ Vai ser muito bom te receber aqui no Instituto.')
) as v(titulo, resposta_ideal)
where e.titulo = v.titulo;

insert into public.ia_exemplos_conversa (titulo, contexto, mensagem_lead, resposta_ideal, tags)
select v.titulo, v.contexto, v.mensagem_lead, v.resposta_ideal, v.tags
from (values
  ('IC23 lead quer cancelar o horario',
   'A Julie já tinha reservado um horário. A pessoa volta dizendo que quer cancelar, sem dizer o motivo.',
   'Bom dia. Estou querendo cancelar.',
'Bom dia! Poxa, tudo bem.

Aconteceu alguma coisa? Me conta o que te fez mudar de ideia.',
   array['geral','emagrecimento','bariátrica']),

  ('IC24 cancelamento por medo',
   'A pessoa pediu para cancelar e, perguntada, contou que está com medo.',
   'Quero cancelar, estou com medo',
'Imagino, e é super normal sentir medo. Muita gente chega aqui assim, e é muito bom que você me contou.

A visita é justamente pra você conhecer a clínica com calma e conversar pessoalmente com um dos nossos especialistas, tirar todas as dúvidas. Nada é decidido ali, você segue no seu tempo.

Que tal manter o seu horário? Se preferir, a gente troca o dia.',
   array['geral','emagrecimento','bariátrica']),

  ('IC25 lead continua decidido a cancelar',
   'A Julie acolheu e tentou manter o horário duas vezes; a pessoa disse de novo que quer cancelar. A Julie cancela com a ferramenta cancelar_agendamento.',
   'Não, obrigada. Quero cancelar mesmo.',
'Tudo bem, respeito a sua decisão. Já cancelei o seu horário, tá?

Obrigada por me contar, e fica à vontade pra me chamar quando quiser 😊',
   array['geral','emagrecimento','bariátrica'])
) as v(titulo, contexto, mensagem_lead, resposta_ideal, tags)
where not exists (select 1 from public.ia_exemplos_conversa e where e.titulo = v.titulo);

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- delete from public.ia_exemplos_conversa where titulo in
--   ('IC23 lead quer cancelar o horario','IC24 cancelamento por medo','IC25 lead continua decidido a cancelar');
-- e rodar de novo o 37_ic_ia_julie_atendimento_completo.sql (volta IC08 e IC16) e o
-- 36_ic_ia_exemplos_tom_leve.sql (volta IC15).
