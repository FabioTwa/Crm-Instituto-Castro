-- 57 Resposta do time sem nome (pedido do Fabio, 26/11/2026)
--
-- Quando o time manda so "confirmada" ou "agendada" na conversa direta, a Jully
-- pergunta pelo paciente mais provavel ("e a Samara (final 3538)?") e marca no
-- "sim". A pergunta aberta de cada numero fica nesta chave (JSON, gerido pela
-- ic-meta-webhook). Idempotente.

insert into public.crm_ia_config (chave, valor, descricao)
values ('time_pergunta', '{}',
        'Pergunta aberta da Jully ao time por numero (SQL 57). Gerido pelo webhook; {} = nenhuma.')
on conflict (chave) do nothing;

select chave, valor from public.crm_ia_config where chave = 'time_pergunta';

-- ZERAR: update public.crm_ia_config set valor = '{}' where chave = 'time_pergunta';
-- ROLLBACK: delete from public.crm_ia_config where chave = 'time_pergunta';
