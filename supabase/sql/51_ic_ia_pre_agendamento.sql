-- 51 Pre-agendamento + call center (reuniao com o Instituto em 19/11/2026)
--
-- Cria DUAS chaves em crm_ia_config. Nao muda nada no atendimento enquanto
-- modo_pre_agendamento = 'false' (padrao deste script).
--
--  modo_pre_agendamento = 'true' liga o fluxo novo da Jully:
--    - oferece um dia com dois horarios e faz a PRE-reserva (status pendente);
--    - diz ao lead que a equipe de agendamento vai entrar em contato pelo
--      WhatsApp do call center para confirmar o horario (e o convenio);
--    - manda o resumo do lead para UM numero do call center (rodizio pelo card),
--      alem do aviso de sempre (aviso_agendamento_whatsapp: Juliana e Kaique);
--    - depois disso nao segue a conversa daquele lead: se ele escrever de novo,
--      no maximo um lembrete por dia com o numero do call center;
--    - o lembrete de confirmacao 24 h antes deixa de sair (quem confirma e o call center).
--  callcenter_whatsapp = numero(s) do call center, com DDD, separados por virgula.
--    Vazio: a Jully fala "pelo WhatsApp" sem numero e o resumo vai so para os
--    numeros do aviso de agendamento. Esses numeros contam como "da casa"
--    (mensagem deles nao vira card).
--
-- Idempotente: nao sobrescreve um valor ja configurado.

insert into public.crm_ia_config (chave, valor, descricao)
values
  ('modo_pre_agendamento', 'false',
   'Pre-agendamento + passagem para o call center (SQL 51). true = liga; false = Jully marca como antes.'),
  ('callcenter_whatsapp', '',
   'WhatsApp do call center que recebe os leads pre-agendados (SQL 51). Um ou mais, separados por virgula.')
on conflict (chave) do nothing;

-- Conferencia
select chave, valor from public.crm_ia_config
 where chave in ('modo_pre_agendamento', 'callcenter_whatsapp', 'aviso_agendamento_whatsapp');

-- LIGAR (quando o IC mandar o numero):
--   update public.crm_ia_config set valor = '5511XXXXXXXXX' where chave = 'callcenter_whatsapp';
--   update public.crm_ia_config set valor = 'true' where chave = 'modo_pre_agendamento';
-- DESLIGAR (volta ao fluxo de antes na hora, sem publicar nada):
--   update public.crm_ia_config set valor = 'false' where chave = 'modo_pre_agendamento';
-- ROLLBACK:
--   delete from public.crm_ia_config where chave in ('modo_pre_agendamento', 'callcenter_whatsapp');
