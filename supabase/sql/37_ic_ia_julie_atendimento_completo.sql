-- 37 Julie: a IA atende o lead ate o agendamento.
--
-- O que muda (so crm_ia_config e exemplos; nenhuma tabela nova):
--   persona_nome / persona_ficha   nome e "quem sou eu" da IA (Julie). A ficha
--                                  nunca traz historia de saude propria.
--   rajada_silencio_segundos 30    espera 30 s sem mensagem nova do lead antes
--   rajada_teto_segundos     60    de responder (nunca segura mais de 60 s)
--   atender_fora_do_horario true   a IA responde a qualquer hora; o horario
--                                  so limita os dias e horas que ela agenda
--   followups_minutos 120,1440,4320  conversa nunca e encerrada: retoma 2 h,
--   followup_horario  08:00-20:00    1 dia e 3 dias depois (seg-sab, 8h-20h)
--   encerrar_apos_minutos 0        desliga o encerramento por inatividade
--   max_respostas_por_conversa 80  a IA conduz a conversa inteira
--   contexto_mensagens 30          a IA le as ultimas 30 mensagens (antes 12)
--   aviso_agendamento_whatsapp ''  numero(s) de quem confirma o agendamento
--                                  com o lead (preencher; vazio = nao avisa)
--   agenda_vagas_por_horario 1     consultas que cabem no mesmo horario
--
-- Exemplos IC08, IC16, IC20 e IC22 passam a falar como a Julie (reserva o
-- horario, se apresenta pelo nome, sabe o Instagram).
--
-- Idempotente: as chaves novas entram com "do nothing"; as tres que ja existiam
-- (encerrar_apos_minutos, max_respostas_por_conversa) sao atualizadas.
-- ROLLBACK no fim do arquivo.

insert into public.crm_ia_config (chave, valor, descricao) values
  ('persona_nome', 'Julie',
   'IC: nome da IA no WhatsApp'),
  ('persona_ficha',
   'Trabalha no atendimento do Instituto Castro há alguns anos e conhece bem a rotina da clínica e da equipe. É simpática, paciente e acolhedora, gosta de gente e de ajudar cada pessoa a dar o primeiro passo no cuidado com a saúde. Fora do trabalho, gosta de cozinhar receitas leves, caminhar no parque aos fins de semana e passar tempo com a família.',
   'IC: quem e a persona (para conversa natural). Nunca incluir historia de saude propria (CFM 2.336/2023)'),
  ('rajada_silencio_segundos', '30', 'IC: segundos sem mensagem nova do lead antes de a IA responder (1 a 60)'),
  ('rajada_teto_segundos', '60', 'IC: maximo de segundos que a IA segura a resposta esperando o lead (ate 90)'),
  ('atender_fora_do_horario', 'true', 'IC: true = a IA responde a qualquer hora; false = fora do horario manda so o aviso'),
  ('followups_minutos', '120,1440,4320', 'IC: retomadas quando o lead para de responder (minutos desde que a conversa parou). Vazio = desliga'),
  ('followup_horario', '08:00-20:00', 'IC: janela local das retomadas (nunca domingo)'),
  ('contexto_mensagens', '30', 'IC: quantas mensagens da conversa a IA le (5 a 60)'),
  ('aviso_agendamento_whatsapp', '', 'IC: WhatsApp de quem confirma os agendamentos da IA (um ou mais, separados por virgula)'),
  ('agenda_vagas_por_horario', '1', 'IC: quantas consultas cabem no mesmo horario da agenda')
on conflict (chave) do nothing;

update public.crm_ia_config set valor = '0' where chave = 'encerrar_apos_minutos';
insert into public.crm_ia_config (chave, valor, descricao) values
  ('encerrar_apos_minutos', '0', 'IC: minutos sem resposta para encerrar a conversa; 0 = nunca (follow-ups no lugar)')
on conflict (chave) do nothing;
update public.crm_ia_config set valor = '80' where chave = 'max_respostas_por_conversa';

update public.ia_exemplos_conversa e
set resposta_ideal = v.resposta_ideal
from (values
  ('IC08 lead quer horario mais tarde por vir de longe',
'Claro! Prontinho, deixei reservado o dia 05/11 (quinta-feira) às 11:00. Alguém da nossa equipe te manda a confirmação com os detalhes por aqui 😊'),
  ('IC16 lead aceita dia e periodo',
'Perfeito! Deixei reservado o dia 22/10 às 11:00 ✨ Logo mais a nossa equipe te manda a confirmação com todos os detalhes por aqui.'),
  ('IC20 com quem estou falando',
'Aqui é a Julie, do atendimento do Instituto Castro 😊 Posso te ajudar a marcar a sua consulta?'),
  ('IC22 informacao que a IA nao tem',
'É @institutocastro! Lá tem bastante coisa sobre os tratamentos 😊 E você, está procurando algum tratamento específico?')
) as v(titulo, resposta_ideal)
where e.titulo = v.titulo;

update public.ia_exemplos_conversa
set contexto = 'Lead pergunta o Instagram da clínica.'
where titulo = 'IC22 informacao que a IA nao tem';

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- delete from public.crm_ia_config where chave in ('persona_nome','persona_ficha','rajada_silencio_segundos',
--   'rajada_teto_segundos','atender_fora_do_horario','followups_minutos','followup_horario','contexto_mensagens',
--   'aviso_agendamento_whatsapp','agenda_vagas_por_horario');
-- update public.crm_ia_config set valor = '60' where chave = 'encerrar_apos_minutos';
-- update public.crm_ia_config set valor = '30' where chave = 'max_respostas_por_conversa';
-- e rodar de novo o 36_ic_ia_exemplos_tom_leve.sql (exemplos IC08, IC16, IC20, IC22).
