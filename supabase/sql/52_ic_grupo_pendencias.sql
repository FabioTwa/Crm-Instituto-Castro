
-- 52 Pendencias do Instituto no grupo do WhatsApp (pedido do Fabio, 23/11/2026)
--
-- Cria as chaves em crm_ia_config. Nada e enviado enquanto
-- grupo_pendencias_ligado = 'false' (padrao deste script).
--
--  grupo_pendencias_ligado = 'true' liga:
--    - uma mensagem por dia (seg-sab, a partir de grupo_pendencias_hora, antes
--      das 20h) no grupo de leitura vinculado ("Treinamento Jully"), so se houver
--      pendencia do Instituto: agendamento a confirmar com o paciente e pedido de
--      agendamento (feito antes do dia) com o card ainda em "Agendamento pendente";
--    - a Jully se identifica como inteligencia artificial; so primeiro nome +
--      final do telefone; nada tecnico;
--    - o time responde no grupo ("Diana confirmada"): o CRM confirma o
--      agendamento / leva o card para a etapa de confirmado, fecha o pedido e
--      reage com ✅ (sem escrever nada).
--  grupo_pendencias_hora = hora local (0-23) a partir da qual sai a mensagem do dia.
--  grupo_pendencias_ultimo = trava do dia (AAAA-MM-DD do ultimo envio). Nao editar.
--  grupo_pendencias_ignorar = telefones que nunca entram na lista (testes),
--    separados por virgula. Os numeros do aviso e do call center ja ficam de fora.
--
-- Idempotente: nao sobrescreve um valor ja configurado.

insert into public.crm_ia_config (chave, valor, descricao)
values
  ('grupo_pendencias_ligado', 'false',
   'Pendencias do Instituto no grupo do WhatsApp (SQL 52). true = liga; false = nao envia nem le respostas.'),
  ('grupo_pendencias_hora', '9',
   'Hora local (0-23) a partir da qual sai a mensagem diaria de pendencias no grupo (SQL 52).'),
  ('grupo_pendencias_ultimo', '',
   'Trava do dia da mensagem de pendencias no grupo (SQL 52). Preenchida pelo sistema; nao editar.'),
  ('grupo_pendencias_ignorar', '',
   'Telefones que nunca entram na lista de pendencias do grupo (SQL 52), separados por virgula.')
on conflict (chave) do nothing;

-- Conferencia
select chave, valor from public.crm_ia_config where chave like 'grupo_pendencias%';

-- LIGAR:
--   update public.crm_ia_config set valor = 'true' where chave = 'grupo_pendencias_ligado';
-- MANDAR HOJE DE NOVO (ex.: teste): limpar a trava
--   update public.crm_ia_config set valor = '' where chave = 'grupo_pendencias_ultimo';
-- DESLIGAR (na hora, sem publicar nada):
--   update public.crm_ia_config set valor = 'false' where chave = 'grupo_pendencias_ligado';
-- ROLLBACK:
--   delete from public.crm_ia_config where chave like 'grupo_pendencias%';
