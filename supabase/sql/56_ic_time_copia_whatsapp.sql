-- 56 Copia do que vai ao time de agendamento (pedido do Fabio, 25/11/2026)
--
-- Numeros em time_copia_whatsapp recebem o mesmo que o numero do time
-- (callcenter_whatsapp): os lembretes de pendencias (10h, 14h e 18h) e os
-- alertas de reclamacao. Nao entram na distribuicao de leads: o paciente
-- continua ouvindo so o numero do time. Respostas desses numeros ("Fulana
-- confirmada") tambem marcam a pendencia no CRM.
--
-- Varios numeros: separados por virgula. Vazio = so o numero do time.
-- Idempotente.

insert into public.crm_ia_config (chave, valor, descricao)
values ('time_copia_whatsapp', '5511916863913',
        'Recebem copia do que vai ao time de agendamento: pendencias e reclamacoes (SQL 56). Vazio = so o callcenter_whatsapp.')
on conflict (chave) do nothing;

select chave, valor from public.crm_ia_config where chave = 'time_copia_whatsapp';

-- DESLIGAR: update public.crm_ia_config set valor = '' where chave = 'time_copia_whatsapp';
-- ROLLBACK: delete from public.crm_ia_config where chave = 'time_copia_whatsapp';
