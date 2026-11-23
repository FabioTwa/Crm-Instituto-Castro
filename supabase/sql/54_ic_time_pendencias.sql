
-- 54 Pendencias tambem na conversa direta com o time de agendamento (pedido do Fabio, 23/11/2026)
--
--  time_pendencias_ligado = 'true' liga: o numero do call center
--    (callcenter_whatsapp, hoje 2020-8098) recebe da Jully a lista de pendencias
--    nos horarios de time_pendencias_horas (seg-sab, antes das 20h), so se houver
--    pendencia. A resposta dele ("Diana confirmada", texto ou audio) atualiza o
--    CRM como no grupo e ganha um ✅. Se disser que confirmou e o nome nao bater,
--    a Jully pede o nome e o final do telefone. Respostas dos numeros de aviso
--    tambem valem.
--  time_pendencias_horas = horas locais separadas por virgula (padrao 10, 14 e 18; ate 23/11 era 9 e 15).
--  time_pendencias_ultimo = trava (AAAA-MM-DD-H do ultimo envio). Nao editar.
--
-- Idempotente: nao sobrescreve um valor ja configurado.

insert into public.crm_ia_config (chave, valor, descricao)
values
  ('time_pendencias_ligado', 'false',
   'Pendencias na conversa direta com o time de agendamento (SQL 54). true = liga.'),
  ('time_pendencias_horas', '10,14,18',
   'Horas locais do aviso de pendencias ao time de agendamento (SQL 54), separadas por virgula.'),
  ('time_pendencias_ultimo', '',
   'Trava do aviso ao time (SQL 54). Preenchida pelo sistema; nao editar.')
on conflict (chave) do nothing;

select chave, valor from public.crm_ia_config where chave like 'time_pendencias%';

-- DESLIGAR: update public.crm_ia_config set valor = 'false' where chave = 'time_pendencias_ligado';
-- ROLLBACK: delete from public.crm_ia_config where chave like 'time_pendencias%';
