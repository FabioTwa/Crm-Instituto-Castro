-- 17 IC: IA de pre-atendimento (consentimento, log de decisao, handoff)
-- IC CRM, camada sobre o esquema base (00-12). Depende de 14 (ic_usuario_atual) e 15.
--
-- LGPD, em tres pecas:
--   * ia_consentimentos: o lead disse sim ou nao para falar com a IA. Nada e
--     respondido por IA sem 'concedido'.
--   * ia_decisoes_log: TODA decisao da IA fica registrada (responder, calar,
--     passar para humano), com custo e latencia. dados_enviados_resumo guarda
--     SO contagem/tipo do que foi para a API externa (ex.: {"mensagens": 6,
--     "tem_nome": true}), nunca o conteudo.
--   * ia_handoffs: fila do humano. Nasce quando a IA desiste (duvida clinica,
--     urgencia, reclamacao, pedido de humano, erro), quando o lead nega o
--     consentimento, quando um agendamento e confirmado (18) ou a mao.
--   * ia_exemplos_conversa: exemplos reais ANONIMIZADOS que o prompt usa.
--     Nasce vazia.
--
-- RPCs: ic_handoffs_pendentes(), ic_handoff_atender(id) para a tela;
-- ic_ia_contexto(cliente, limite) SO para a Edge Function (service_role):
-- devolve o MINIMO que a IA precisa (primeiro nome, funil, etapa, status do
-- consentimento, ultimas N mensagens). Sem cpf, e-mail, profissao, anuncio.
--
-- RLS: select para logados (ia_decisoes_log so Admin); escrita so
-- service_role, exceto ia_handoffs (insert/update por logados: handoff manual
-- e "atender").
-- Idempotente.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------
create table if not exists public.ia_consentimentos (
  id               uuid primary key default gen_random_uuid(),
  cliente_crm_id   uuid not null references public.clientes_crm(id),
  telefone_norm    text,
  status           text not null default 'pendente' check (status in ('pendente', 'concedido', 'negado', 'revogado')),
  texto_apresentado text,
  respondido_em    timestamptz,
  canal            text default 'whatsapp',
  criado_em        timestamptz default now()
);
create index if not exists idx_ia_consentimentos_cliente on public.ia_consentimentos (cliente_crm_id, criado_em desc);
comment on table public.ia_consentimentos is 'IC/LGPD: consentimento do lead para atendimento por IA. texto_apresentado e o que ele leu. Sem concedido a IA nao responde.';

create table if not exists public.ia_decisoes_log (
  id                     bigserial primary key,
  cliente_crm_id         uuid,
  conversa_id            uuid,
  criado_em              timestamptz default now(),
  etapa_pipeline         text not null,
  decisao                text not null,
  motivo                 text,
  modelo                 text,
  tokens_entrada         integer,
  tokens_saida           integer,
  latencia_ms            integer,
  dados_enviados_resumo  jsonb,
  resposta_enviada       boolean default false,
  detalhe                jsonb
);
create index if not exists idx_ia_decisoes_cliente on public.ia_decisoes_log (cliente_crm_id, criado_em desc);
create index if not exists idx_ia_decisoes_data on public.ia_decisoes_log (criado_em desc);
comment on table public.ia_decisoes_log is 'IC/LGPD: toda decisao da IA (responder, calar, handoff), com modelo, tokens e latencia.';
comment on column public.ia_decisoes_log.dados_enviados_resumo is 'SO contagem/tipo do que foi para a API externa (ex.: {"mensagens":6,"tem_nome":true,"etapa":"em_conversa"}). NUNCA o conteudo das mensagens nem dado pessoal.';
comment on column public.ia_decisoes_log.etapa_pipeline is 'Em que passo do pipeline a decisao foi tomada: consentimento, classificacao, resposta, handoff, erro.';

create table if not exists public.ia_handoffs (
  id              uuid primary key default gen_random_uuid(),
  cliente_crm_id  uuid not null references public.clientes_crm(id),
  motivo          text not null check (motivo in ('duvida_clinica', 'urgencia', 'reclamacao', 'pedido_humano', 'agendamento_confirmado', 'consentimento_negado', 'erro_ia', 'manual')),
  detalhe         text,
  criado_em       timestamptz default now(),
  atendido_por    text,
  atendido_em     timestamptz
);
create index if not exists idx_ia_handoffs_pendentes on public.ia_handoffs (criado_em) where atendido_em is null;
create index if not exists idx_ia_handoffs_cliente on public.ia_handoffs (cliente_crm_id);
comment on table public.ia_handoffs is 'IC: fila de passagem IA -> humano. atendido_em nulo = pendente.';

create table if not exists public.ia_exemplos_conversa (
  id              uuid primary key default gen_random_uuid(),
  titulo          text,
  contexto        text,
  mensagem_lead   text,
  resposta_ideal  text,
  tags            text[],
  ativo           boolean default true,
  criado_em       timestamptz default now()
);
comment on table public.ia_exemplos_conversa is 'IC: exemplos reais ANONIMIZADOS (sem nome, telefone ou dado clinico identificavel) que o prompt da IA usa como referencia. Nasce vazia.';

-- ---------------------------------------------------------------------------
-- 2. Configuracao da IA (chave 'ligada' ja vem do 13)
-- ---------------------------------------------------------------------------
insert into public.crm_ia_config (chave, valor, descricao) values
  ('ligada',                    'false',             'IC: IA de pre-atendimento desligada por padrao'),
  ('horario_inicio',            '08:00',             'IC: a IA so responde a partir desta hora (America/Sao_Paulo)'),
  ('horario_fim',               '19:00',             'IC: a IA para de responder nesta hora'),
  ('max_respostas_por_conversa','6',                 'IC: depois disso passa para humano'),
  ('modelo',                    'claude-sonnet-5-5', 'IC: modelo usado pela Edge Function')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- 3. RPCs
-- ---------------------------------------------------------------------------
create or replace function public.ic_handoffs_pendentes()
returns table (id uuid, cliente_crm_id uuid, nome text, telefone text, motivo text, detalhe text, criado_em timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select h.id, h.cliente_crm_id, c.nome, c.telefone, h.motivo, h.detalhe, h.criado_em
  from public.ia_handoffs h
  join public.clientes_crm c on c.id = h.cliente_crm_id
  where h.atendido_em is null
    and c.deleted_at is null
    and public.ic_card_no_escopo(c.vendedor_id)
  order by h.criado_em;
$$;
comment on function public.ic_handoffs_pendentes() is 'IC: handoffs sem atendimento, com nome e telefone do card, no escopo do usuario atual.';

create or replace function public.ic_handoff_atender(p_id uuid)
returns public.ia_handoffs
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users;
  r public.ia_handoffs;
begin
  u := public.ic_usuario_atual();
  update public.ia_handoffs
  set atendido_em = now(),
      atendido_por = coalesce(u.name, u.email, auth.jwt() ->> 'email', 'desconhecido')
  where id = p_id and atendido_em is null
  returning * into r;
  return r;
end;
$$;
comment on function public.ic_handoff_atender(uuid) is 'IC: marca o handoff como atendido pelo usuario atual. Devolve a linha (nula se ja estava atendido).';

create or replace function public.ic_ia_contexto(p_cliente uuid, p_limite integer default 12)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'cliente_id', c.id,
    'primeiro_nome', nullif(split_part(btrim(coalesce(c.nome, '')), ' ', 1), ''),
    'funil', f.nome,
    'etapa', coalesce(e.label, e.nome, c.etapa),
    'etapa_chave', c.etapa,
    'consentimento', coalesce(
      (select k.status from public.ia_consentimentos k where k.cliente_crm_id = c.id order by k.criado_em desc limit 1),
      'pendente'),
    'respostas_ia', (select count(*) from public.ia_decisoes_log d where d.cliente_crm_id = c.id and d.resposta_enviada),
    'handoff_pendente', exists (select 1 from public.ia_handoffs h where h.cliente_crm_id = c.id and h.atendido_em is null),
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('autor', m.autor, 'exibicao', m.exibicao, 'criada_em', m.criada_em) order by m.criada_em)
      from (
        select m.autor, m.exibicao, m.criada_em
        from public.crm_conversas m
        where m.cliente_crm_id = c.id and m.exibicao is not null
        order by m.criada_em desc
        limit greatest(coalesce(p_limite, 12), 1)
      ) m
    ), '[]'::jsonb)
  )
  from public.clientes_crm c
  left join public.crm_funis f on f.id = c.funil_id
  left join public.crm_funil_etapas e on e.funil_id = c.funil_id and e.nome = c.etapa
  where c.id = p_cliente;
$$;
comment on function public.ic_ia_contexto(uuid, integer) is 'IC/LGPD: o MINIMO para a IA: primeiro nome, funil, etapa, consentimento, ultimas N mensagens. Sem cpf, e-mail, profissao, anuncio. So service_role (Edge Function).';

revoke execute on function public.ic_handoffs_pendentes() from public, anon;
grant execute on function public.ic_handoffs_pendentes() to authenticated, service_role;
revoke execute on function public.ic_handoff_atender(uuid) from public, anon;
grant execute on function public.ic_handoff_atender(uuid) to authenticated, service_role;
revoke execute on function public.ic_ia_contexto(uuid, integer) from public, anon, authenticated;
grant execute on function public.ic_ia_contexto(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
alter table public.ia_consentimentos enable row level security;
drop policy if exists "ic_ia_consent_select" on public.ia_consentimentos;
create policy "ic_ia_consent_select" on public.ia_consentimentos for select to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));

alter table public.ia_decisoes_log enable row level security;
drop policy if exists "ic_ia_decisoes_select" on public.ia_decisoes_log;
create policy "ic_ia_decisoes_select" on public.ia_decisoes_log for select to authenticated
  using (public.ic_eh_admin());

alter table public.ia_handoffs enable row level security;
drop policy if exists "ic_ia_handoffs_select" on public.ia_handoffs;
drop policy if exists "ic_ia_handoffs_insert" on public.ia_handoffs;
drop policy if exists "ic_ia_handoffs_update" on public.ia_handoffs;
create policy "ic_ia_handoffs_select" on public.ia_handoffs for select to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
create policy "ic_ia_handoffs_insert" on public.ia_handoffs for insert to authenticated
  with check (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));
create policy "ic_ia_handoffs_update" on public.ia_handoffs for update to authenticated
  using (exists (select 1 from public.clientes_crm c where c.id = cliente_crm_id));

alter table public.ia_exemplos_conversa enable row level security;
drop policy if exists "ic_ia_exemplos_select" on public.ia_exemplos_conversa;
drop policy if exists "ic_ia_exemplos_admin" on public.ia_exemplos_conversa;
create policy "ic_ia_exemplos_select" on public.ia_exemplos_conversa for select to authenticated using (true);
create policy "ic_ia_exemplos_admin" on public.ia_exemplos_conversa for all to authenticated
  using (public.ic_eh_admin()) with check (public.ic_eh_admin());

commit;

-- ROLLBACK:
-- begin;
-- drop function if exists public.ic_ia_contexto(uuid, integer);
-- drop function if exists public.ic_handoff_atender(uuid);
-- drop function if exists public.ic_handoffs_pendentes();
-- drop table if exists public.ia_exemplos_conversa;
-- drop table if exists public.ia_handoffs;        -- o 18 (gatilho) insere aqui: rode o rollback do 18 antes
-- drop table if exists public.ia_decisoes_log;
-- drop table if exists public.ia_consentimentos;
-- delete from public.crm_ia_config where chave in ('horario_inicio','horario_fim','max_respostas_por_conversa','modelo');
-- commit;
