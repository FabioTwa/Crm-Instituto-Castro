-- 37 Julie: a IA atende o lead ate o agendamento.
--
-- O que muda (crm_ia_config, exemplos e a trava ia_vez):
--   persona_nome / persona_ficha   nome e "quem sou eu" da IA (Julie). A ficha
--                                  nunca traz historia de saude propria.
--   rajada_silencio_segundos 30    espera 30 s sem mensagem nova do lead antes
--   rajada_teto_segundos     60    de responder (nunca segura mais de 60 s)
--   atender_fora_do_horario true   a IA responde a qualquer hora; o horario
--                                  so limita os dias e horas que ela agenda
--   followups_minutos ''           sem retomada: lead que para de responder
--   followup_horario  08:00-20:00    nao recebe retorno (decisao 21/10/2026);
--                                  '120,1440,4320' liga 2 h / 1 dia / 3 dias
--   encerrar_apos_minutos 0        conversa nunca e encerrada por inatividade
--   atender_um_por_vez true        a IA conversa com UM lead por vez (trava
--   fila_espera_segundos 35        ia_vez); quem espera mais que isso volta
--                                  para a fila (ate 6 vezes, depois equipe)
--   max_respostas_por_conversa 80  a IA conduz a conversa inteira
--   contexto_mensagens 30          a IA le as ultimas 30 mensagens (antes 12)
--   aviso_agendamento_whatsapp     numero(s) de quem confirma o agendamento
--                                  com o lead. TESTE: 5511972663460 (no lugar
--                                  do Kaique). Esses numeros nao viram card.
--   agenda_vagas_por_horario 1     consultas que cabem no mesmo horario
--
-- Exemplos IC08, IC16, IC20 e IC22 passam a falar como a Julie (reserva o
-- horario, se apresenta pelo nome, sabe o Instagram).
--
-- Idempotente: as chaves novas entram com "do nothing"; as que ja existiam
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
  ('followups_minutos', '', 'IC: retomadas quando o lead para de responder (minutos desde que a conversa parou, ex.: 120,1440,4320). Vazio = sem retomada'),
  ('followup_horario', '08:00-20:00', 'IC: janela local das retomadas (nunca domingo)'),
  ('contexto_mensagens', '30', 'IC: quantas mensagens da conversa a IA le (5 a 60)'),
  ('aviso_agendamento_whatsapp', '5511972663460', 'IC: WhatsApp de quem confirma os agendamentos da IA (um ou mais, separados por virgula). 5511972663460 = teste no lugar do Kaique'),
  ('atender_um_por_vez', 'true', 'IC: true = a IA conversa com um lead por vez (trava ia_vez)'),
  ('fila_espera_segundos', '35', 'IC: quanto um lead espera a vez antes de voltar para a fila (5 a 60)'),
  ('agenda_vagas_por_horario', '1', 'IC: quantas consultas cabem no mesmo horario da agenda')
on conflict (chave) do nothing;

-- Trava "um lead por vez": uma linha so. dono = invocacao que esta atendendo,
-- ate = prazo (se a funcao cair, a trava expira sozinha).
create table if not exists public.ia_vez (
  id    integer primary key default 1 check (id = 1),
  dono  text,
  ate   timestamptz
);
comment on table public.ia_vez is 'IC: trava da IA para atender um lead por vez (ic_ia_pegar_vez / ic_ia_soltar_vez). So service_role.';
insert into public.ia_vez (id) values (1) on conflict (id) do nothing;
alter table public.ia_vez enable row level security;
revoke all on public.ia_vez from public, anon, authenticated;

create or replace function public.ic_ia_pegar_vez(p_dono text, p_segundos integer default 90)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if coalesce(p_dono, '') = '' then
    return false;
  end if;
  update public.ia_vez
     set dono = p_dono,
         ate = now() + make_interval(secs => greatest(10, least(coalesce(p_segundos, 90), 180)))
   where id = 1 and (dono is null or ate is null or ate < now() or dono = p_dono);
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
comment on function public.ic_ia_pegar_vez(text, integer) is 'IC: pega a vez de a IA atender (um lead por vez). true = pegou; a trava expira em p_segundos.';

create or replace function public.ic_ia_soltar_vez(p_dono text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ia_vez set dono = null, ate = null where id = 1 and dono = p_dono;
$$;
comment on function public.ic_ia_soltar_vez(text) is 'IC: solta a vez da IA (so quem pegou).';

revoke execute on function public.ic_ia_pegar_vez(text, integer) from public, anon, authenticated;
revoke execute on function public.ic_ia_soltar_vez(text) from public, anon, authenticated;
grant execute on function public.ic_ia_pegar_vez(text, integer) to service_role;
grant execute on function public.ic_ia_soltar_vez(text) to service_role;

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
-- drop function if exists public.ic_ia_pegar_vez(text, integer);
-- drop function if exists public.ic_ia_soltar_vez(text);
-- drop table if exists public.ia_vez;
-- delete from public.crm_ia_config where chave in ('persona_nome','persona_ficha','rajada_silencio_segundos',
--   'rajada_teto_segundos','atender_fora_do_horario','followups_minutos','followup_horario','contexto_mensagens',
--   'aviso_agendamento_whatsapp','agenda_vagas_por_horario','atender_um_por_vez','fila_espera_segundos');
-- update public.crm_ia_config set valor = '60' where chave = 'encerrar_apos_minutos';
-- update public.crm_ia_config set valor = '30' where chave = 'max_respostas_por_conversa';
-- e rodar de novo o 36_ic_ia_exemplos_tom_leve.sql (exemplos IC08, IC16, IC20, IC22).
