-- 39 Lembrete de confirmacao do horario marcado (TEMPORARIO, pedido do Fabio
-- em 23/10/2026).
--
-- A IA escreve para a pessoa 24 h antes do horario marcado (visita ou consulta,
-- status pendente ou confirmado) pedindo que ela confirme a presenca. A resposta
-- segue pelo atendimento normal da IA. Codigo: ic-ia-pre-atendimento
-- (lembrarConfirmacoes) e _shared/confirmacao-agendamento.ts.
--
-- Regras: so quem autorizou o atendimento automatico (LGPD); so agendamentos
-- marcados com mais de 24 h de antecedencia; de 08:00 as 20:00
-- (followup_horario), nunca aos domingos (segunda-feira e lembrada no sabado);
-- uma vez por agendamento e horario (se remarcar, lembra o novo horario).
--
-- LIGAR (este arquivo):   valor '24'
-- DESLIGAR:               update public.crm_ia_config set valor = '' where chave = 'confirmacao_antes_horas';
--
-- Idempotente. ROLLBACK no fim do arquivo.

insert into public.crm_ia_config (chave, valor, descricao)
values ('confirmacao_antes_horas', '24',
  'Lembrete de confirmacao: horas antes do horario marcado. Vazio ou 0 = desligado (SQL 39).')
on conflict (chave) do update set valor = excluded.valor, descricao = excluded.descricao;

-- ROLLBACK
-- delete from public.crm_ia_config where chave = 'confirmacao_antes_horas';
