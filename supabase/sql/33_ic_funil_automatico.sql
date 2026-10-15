-- 33 Card anda sozinho pelo funil conforme a conversa com a IA.
--
-- ic_avancar_etapa(card, evento, autor, motivo): move o card para a etapa do
-- funil ligada ao evento, SO PARA FRENTE (ordem maior que a atual). Nunca
-- mexe em fechado / perdido / cliente_antigo, card apagado ou mesclado.
-- Funil sem etapa para o evento: nao faz nada. Grava crm_historico.
--
-- Eventos e etapas (a primeira que existir no funil do card):
--   conversa    em_conversa                       (a IA respondeu de verdade)
--   negociacao  negociacao, negociacao_quente     (lead perguntou valor, convenio, formato)
--   proposta    agendamento_pendente, avaliacao_inicial  (a IA propos horario)
--   confirmado  visita_confirmada, consulta_agendada, avaliacao_inicial,
--               agendamento_pendente              (a equipe confirmou o agendamento)
--
-- O gatilho de agendamento confirmado (SQL 18) passa a usar a mesma funcao:
-- no Atendimento Geral o card vai para "Visita Confirmada" (antes ia para
-- "Agendamento Pendente").
--
-- Chamada pela Edge Function ic-ia-pre-atendimento (service_role) e pelo gatilho.
-- Aditivo: cria uma funcao e troca o corpo do gatilho. Idempotente. ROLLBACK no fim.

create or replace function public.ic_avancar_etapa(
  p_cliente uuid,
  p_evento  text,
  p_autor   text default 'Assistente virtual',
  p_motivo  text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c            public.clientes_crm;
  candidatas   text[];
  alvo_nome    text;
  alvo_ordem   integer;
  atual_ordem  integer;
begin
  candidatas := case p_evento
    when 'conversa'   then array['em_conversa']
    when 'negociacao' then array['negociacao', 'negociacao_quente']
    when 'proposta'   then array['agendamento_pendente', 'avaliacao_inicial']
    when 'confirmado' then array['visita_confirmada', 'consulta_agendada', 'avaliacao_inicial', 'agendamento_pendente']
    else null
  end;
  if candidatas is null then
    return null;
  end if;

  select * into c from public.clientes_crm where id = p_cliente;
  if c.id is null or c.deleted_at is not null or c.mesclado_para is not null
     or c.etapa in ('fechado', 'perdido', 'cliente_antigo') then
    return null;
  end if;

  select e.nome, e.ordem into alvo_nome, alvo_ordem
  from public.crm_funil_etapas e
  where e.funil_id = c.funil_id and e.nome = any (candidatas)
  order by array_position(candidatas, e.nome)
  limit 1;
  if alvo_nome is null then
    return null;
  end if;

  select e.ordem into atual_ordem
  from public.crm_funil_etapas e
  where e.funil_id = c.funil_id and e.nome = c.etapa;

  -- So para frente. Etapa atual fora do funil (null): nao arrisca mover.
  if atual_ordem is null or atual_ordem >= alvo_ordem then
    return null;
  end if;

  update public.clientes_crm set etapa = alvo_nome, updated_at = now() where id = c.id;
  insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo)
  values (c.id, c.etapa, alvo_nome, coalesce(nullif(p_autor, ''), 'Assistente virtual'),
          'Movido automaticamente: ' || coalesce(nullif(p_motivo, ''), p_evento), 'automatico');
  return alvo_nome;
end;
$$;
comment on function public.ic_avancar_etapa(uuid, text, text, text) is 'IC: move o card para a etapa ligada ao evento (conversa, negociacao, proposta, confirmado), so para frente. Nunca mexe em fechado/perdido/cliente_antigo.';

revoke execute on function public.ic_avancar_etapa(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ic_avancar_etapa(uuid, text, text, text) to service_role;

-- Chave para desligar o movimento feito pela IA (o gatilho de agendamento
-- confirmado continua, como ja era no SQL 18).
insert into public.crm_ia_config (chave, valor, descricao) values
  ('funil_automatico', 'true', 'IC: true = a IA move o card no funil (em conversa, negociacao, agendamento pendente), so para frente; false = desliga')
on conflict (chave) do nothing;

-- Gatilho do agendamento confirmado (SQL 18): mesmo handoff, etapa pela funcao acima.
create or replace function public.ic_agendamento_confirmado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.clientes_crm;
begin
  if new.status <> 'confirmado' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'confirmado' then
    return new;  -- ja estava confirmado: nada a fazer
  end if;

  select * into c from public.clientes_crm where id = new.cliente_crm_id;
  if c.id is null then
    return new;
  end if;

  -- (a) handoff para o humano, uma vez por agendamento pendente
  if not exists (
    select 1 from public.ia_handoffs h
    where h.cliente_crm_id = c.id and h.motivo = 'agendamento_confirmado' and h.atendido_em is null
  ) then
    insert into public.ia_handoffs (cliente_crm_id, motivo, detalhe)
    values (c.id, 'agendamento_confirmado',
            coalesce(new.titulo, 'Agendamento') || ' em ' || to_char(new.inicio at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'));
  end if;

  -- (b) move o card para a etapa de agendamento confirmado do funil, so para frente
  perform public.ic_avancar_etapa(c.id, 'confirmado', 'Sistema',
                                  'agendamento confirmado (' || coalesce(new.titulo, '') || ')');
  return new;
end;
$$;
comment on function public.ic_agendamento_confirmado() is 'IC: ao confirmar um agendamento, abre handoff agendamento_confirmado e move o card (ic_avancar_etapa evento confirmado: visita_confirmada/consulta_agendada/avaliacao_inicial/agendamento_pendente), so para frente.';

-- ---------------------------------------------------------------------------
-- ROLLBACK: rodar de novo a funcao ic_agendamento_confirmado do 18_ic_agendamentos.sql e
-- drop function if exists public.ic_avancar_etapa(uuid, text, text, text);
-- delete from public.crm_ia_config where chave = 'funil_automatico';
-- Para so desligar sem rollback: update public.crm_ia_config set valor = 'false' where chave = 'funil_automatico';
