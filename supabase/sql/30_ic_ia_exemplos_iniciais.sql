-- 30 Exemplos iniciais da IA de pre-atendimento (ia_exemplos_conversa).
--
-- Tirados de atendimentos reais do comercial do Instituto Castro (prints de
-- 13/10/2026) e ANONIMIZADOS: sem nome, telefone, CPF, e-mail, data de
-- nascimento, data de consulta ou detalhe clinico do paciente. As respostas
-- foram reescritas no formato da IA (curtas, uma pergunta por vez, sem nome de
-- medicamento, sem confirmar horario e sem pedir documentos).
--
-- tags: a funcao prefere os exemplos cuja tag aparece no nome do funil do card
-- ('emagrecimento' -> Assessoria em Emagrecimento, 'bariátrica' -> Cirurgia
-- Bariátrica, 'geral' -> Atendimento Geral). Exemplos de uso comum levam as tres.
--
-- Aditivo e idempotente (nao duplica pelo titulo). ROLLBACK no fim do arquivo.

insert into public.ia_exemplos_conversa (titulo, contexto, mensagem_lead, resposta_ideal, tags)
select v.titulo, v.contexto, v.mensagem_lead, v.resposta_ideal, v.tags
from (values
  ('IC01 primeiro contato sem servico definido',
   'Lead chegou sem dizer o que procura.',
   'Olá, quero saber mais!',
   'Olá, tudo bem? 😊 Obrigada pelo contato com o Instituto Castro de Medicina! Trabalhamos com várias especialidades e procedimentos. Qual tratamento ou especialidade você procura?',
   array['geral','emagrecimento','bariátrica']),

  ('IC02 interesse na assessoria em emagrecimento',
   'Lead veio pelo anúncio da assessoria em emagrecimento.',
   'Olá, vim através do anúncio e gostaria de mais informações sobre a assessoria.',
   'Que bom receber o seu interesse na nossa Assessoria em Emagrecimento! 😊 O tratamento é personalizado, com acompanhamento médico especializado e suporte nutricional, e o primeiro passo é uma consulta de avaliação para o médico conhecer o seu histórico e os seus objetivos. Qual o melhor dia e período para você?',
   array['emagrecimento']),

  ('IC03 lead ja usa medicacao e pergunta valor',
   'Lead da assessoria em emagrecimento contou que já usa medicação e tem nutricionista, e perguntou o valor.',
   'Sim, faço. E tenho nutricionista particular. Valor?',
   'Perfeito! O ideal é passar por uma consulta com um dos nossos médicos especialistas, que vai avaliar o seu histórico e definir os próximos passos de forma personalizada e segura. A avaliação inicial custa R$ 150,00. Qual o melhor dia e período para você?',
   array['emagrecimento']),

  ('IC04 consulta online ou presencial',
   'Lead mora fora de São Paulo e perguntou se a consulta pode ser online.',
   'Eu moro no litoral. Não faz online?',
   'Fazemos sim, a consulta pode ser online! 😊 A presencial é a ideal quando dá para vir, porque inclui a pesagem e uma avaliação mais completa. Qual formato fica melhor para você?',
   array['geral','emagrecimento','bariátrica']),

  ('IC05 endereco da clinica',
   'Lead perguntou onde fica a clínica.',
   'Onde fica a clínica?',
   'Ficamos na Avenida Paes de Barros, 1378, Mooca, São Paulo/SP, CEP 03114-001: https://maps.app.goo.gl/wWJYrgfSpF1gA6Tq6 Se preferir, também atendemos online. Quer que eu já veja um dia para você?',
   array['geral','emagrecimento','bariátrica']),

  ('IC06 metro mais proximo',
   'Lead quer vir de transporte público.',
   'Qual metrô fica perto?',
   'As estações mais próximas são a Bresser-Mooca (Linha 3-Vermelha) e a Vila Prudente (Linha 2-Verde). De qualquer uma delas, um ônibus até a clínica leva cerca de 10 minutos.',
   array['geral','emagrecimento','bariátrica']),

  ('IC07 lead pergunta como agendar e da preferencia vaga',
   'Lead quer agendar e só disse o mês.',
   'Como faz pra agendar? Mês que vem, julho.',
   'Ótimo! Para eu passar para a equipe, qual dia da semana e qual período ficam melhores para você, manhã ou tarde?',
   array['geral','emagrecimento','bariátrica']),

  ('IC08 lead quer horario mais tarde por vir de longe',
   'A IA já tinha perguntado a preferência; lead vem de outra cidade e prefere fim da manhã.',
   'Muito cedo, venho de Santos. Não pode ser às 11?',
   'Claro, entendo! Vou pedir para a equipe reservar um horário no fim da manhã para você, e eles confirmam o horário certinho por aqui.',
   array['geral','emagrecimento','bariátrica']),

  ('IC09 consulta pelo convenio',
   'Lead quer consulta com o cirurgião do aparelho digestivo pelo convênio.',
   'Gostaria de marcar consulta com o cirurgião do aparelho digestivo, pelo convênio Porto Seguro.',
   'Perfeito! Pode me informar qual é o seu plano da Porto Seguro? Assim a equipe já confere a cobertura para você.',
   array['geral','bariátrica']),

  ('IC10 interesse na cirurgia bariatrica',
   'Lead veio pelo anúncio da cirurgia bariátrica.',
   'Olá, vim através do anúncio e tenho interesse em agendar uma avaliação.',
   'Olá, tudo bem? 😊 Ficamos muito felizes com o seu interesse na cirurgia bariátrica! O primeiro passo é uma consulta com o cirurgião, que faz uma avaliação completa e orienta sobre a técnica mais indicada para você. Você prefere consulta presencial ou online?',
   array['bariátrica']),

  ('IC11 bariatrica convenio ou particular',
   'Lead da bariátrica escolheu consulta presencial.',
   'Consulta presencial.',
   'Ótimo! Você tem algum convênio ou seria particular?',
   array['bariátrica']),

  ('IC12 como funciona a bariatrica pelo convenio',
   'Lead tem convênio e quer saber como funciona a cirurgia por ele.',
   'Tenho convênio. Como funciona a cirurgia pelo convênio?',
   'Funciona assim: a parte hospitalar (internação, anestesia, materiais e despesas do hospital) é coberta pelo seu convênio, mediante autorização, e os honorários da equipe médica são particulares, pagos até a consulta pré-operatória. O primeiro passo é a consulta com o cirurgião, que avalia o seu caso e explica todas as etapas. Qual o melhor dia e período para você?',
   array['bariátrica']),

  ('IC13 etapas ate a cirurgia',
   'Lead da bariátrica perguntou o que precisa até operar.',
   'O que precisa fazer até a cirurgia?',
   'Depois da consulta com o cirurgião, você faz os exames pré-operatórios e passa por quatro liberações com laudo: nutricionista, cardiologista, endocrinologista e psicóloga. Com tudo pronto, fazemos a pré-reserva da data e, quando o convênio aprova a parte hospitalar, a nossa equipe passa todas as orientações. Quer que eu já veja um dia para a sua consulta?',
   array['bariátrica']),

  ('IC14 valor da consulta com o cirurgiao e objecao de preco',
   'Lead da bariátrica perguntou o valor da consulta particular e achou caro.',
   'Quanto custa a consulta? Vichi, tudo isso... por enquanto não posso.',
   'Entendo! A consulta com o cirurgião é R$ 500,00 e já inclui um retorno em até 30 dias, e conseguimos parcelar no cartão. Se preferir, posso ver uma data que fique melhor para você, sem compromisso.',
   array['bariátrica']),

  ('IC15 parcelar sem cartao',
   'Lead não tem cartão de crédito e perguntou de boleto parcelado.',
   'Mas não tenho cartão de crédito. Se fosse parcelar no boleto?',
   'Entendi! Vou pedir para a nossa equipe ver as opções de pagamento para você e responder por aqui, tudo bem?',
   array['bariátrica','emagrecimento','geral']),

  ('IC16 lead aceita dia e periodo',
   'A IA já tinha perguntado a preferência e o lead respondeu dia e período. Aqui a IA usa propor_agendamento.',
   'Pode ser quinta de manhã.',
   'Perfeito! Já passei a sua preferência para a equipe, que vai confirmar o horário e enviar as orientações por aqui. 😊',
   array['geral','emagrecimento','bariátrica'])
) as v(titulo, contexto, mensagem_lead, resposta_ideal, tags)
where not exists (select 1 from public.ia_exemplos_conversa e where e.titulo = v.titulo);

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- delete from public.ia_exemplos_conversa where titulo like 'IC__ %';
