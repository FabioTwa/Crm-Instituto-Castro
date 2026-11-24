-- 55 Reclamacao de paciente vira alerta no grupo do IC e ao time de agendamento
--    (pedido do Fabio, 24/11/2026)
--
-- A ic-ia-pre-atendimento grava aqui quando a mensagem do paciente e uma
-- reclamacao clara (falta de retorno ou insatisfacao). O varredor da
-- ic-meta-webhook envia o alerta (apresentacao da Jully, motivo, o que
-- aconteceu, nome e telefone) no grupo, marcando grupo_pendencias_marcar, e ao
-- numero do time (callcenter_whatsapp). Seg-sab, das 8h as 20h; fora disso fica
-- na fila. Um alerta por paciente a cada 24 h.
--
-- alerta_reclamacao_ligado = 'false' desliga (nada e gravado nem enviado).
-- Idempotente.

create table if not exists public.ic_alertas_reclamacao (
  id               uuid primary key default gen_random_uuid(),
  cliente_crm_id   uuid not null,
  nome             text,
  telefone         text not null,
  mensagem         text not null,
  motivo           text not null check (motivo in ('sem_retorno', 'insatisfacao')),
  termo            text,
  contexto         text not null,
  tem_pedido       boolean not null default false,
  recebida_em      timestamptz not null default now(),
  criado_em        timestamptz not null default now(),
  enviado_grupo_em timestamptz,
  enviado_time_em  timestamptz,
  tentativas       integer not null default 0
);

create index if not exists ic_alertas_reclamacao_cliente_idx
  on public.ic_alertas_reclamacao (cliente_crm_id, criado_em desc);
create index if not exists ic_alertas_reclamacao_fila_idx
  on public.ic_alertas_reclamacao (criado_em)
  where enviado_grupo_em is null or enviado_time_em is null;

-- Dados de paciente: so o service role (funcoes) escreve; no CRM, so Admin le.
alter table public.ic_alertas_reclamacao enable row level security;
revoke all on public.ic_alertas_reclamacao from anon, authenticated;
grant select on public.ic_alertas_reclamacao to authenticated;
grant all on public.ic_alertas_reclamacao to service_role;
drop policy if exists ic_alertas_reclamacao_admin_le on public.ic_alertas_reclamacao;
create policy ic_alertas_reclamacao_admin_le on public.ic_alertas_reclamacao
  for select to authenticated using (public.ic_eh_admin());

insert into public.crm_ia_config (chave, valor, descricao)
values ('alerta_reclamacao_ligado', 'true',
        'Reclamacao de paciente vira alerta no grupo e ao time de agendamento (SQL 55). false = desliga.')
on conflict (chave) do nothing;

select chave, valor from public.crm_ia_config where chave = 'alerta_reclamacao_ligado';

-- DESLIGAR: update public.crm_ia_config set valor = 'false' where chave = 'alerta_reclamacao_ligado';
-- ROLLBACK: delete from public.crm_ia_config where chave = 'alerta_reclamacao_ligado';
--           drop table if exists public.ic_alertas_reclamacao;
