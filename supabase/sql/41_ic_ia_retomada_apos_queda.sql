-- 41 Retomada depois de queda do WhatsApp (Z-API).
--
-- Quando o numero cai, as mensagens que chegam nesse periodo NAO vem para o
-- CRM (teste de 28/10/2026), e a Z-API nao tem rota documentada para ler o
-- texto delas depois. O que da para saber, pela lista de conversas da Z-API,
-- e QUEM falou durante a queda. A Jully retoma essas pessoas uma por vez,
-- pedindo com naturalidade que mandem de novo.
--
--   ic_whatsapp_quedas   uma linha por queda de cada numero Z-API
--                        (desconectado_em ate reconectado_em). Gravada pelo
--                        varredor (1x por minuto), que consulta o status.
--   ic_retomada_queda    fila: quem mandou mensagem durante a queda. A IA
--                        atende uma por vez (estado pendente -> processando -> enviada /
--                        ignorada / falhou).
--
--   crm_ia_config:
--   retomada_queda_ligada         'true' liga; 'false' desliga tudo isto
--   retomada_queda_intervalo_min  minutos entre uma retomada e outra (3)
--   retomada_queda_horario        janela local (nunca domingo); fora dela a
--                                 fila espera o proximo horario
--   retomada_queda_desconhecidos  'true' tambem chama numeros sem card no CRM
--                                 (lead novo que escreveu durante a queda)
--
-- So service_role le e escreve as tabelas. Idempotente. ROLLBACK no fim.

create table if not exists public.ic_whatsapp_quedas (
  id               uuid primary key default gen_random_uuid(),
  linha_id         uuid not null references public.vendedores_whatsapp(id) on delete cascade,
  desconectado_em  timestamptz not null default now(),
  reconectado_em   timestamptz,
  conversas        integer,
  criado_em        timestamptz not null default now()
);
comment on table public.ic_whatsapp_quedas is 'IC: periodos em que o WhatsApp (Z-API) ficou desconectado. So service_role.';
create unique index if not exists ic_whatsapp_quedas_aberta
  on public.ic_whatsapp_quedas (linha_id) where reconectado_em is null;
alter table public.ic_whatsapp_quedas enable row level security;
revoke all on public.ic_whatsapp_quedas from public, anon, authenticated;

create table if not exists public.ic_retomada_queda (
  id              uuid primary key default gen_random_uuid(),
  queda_id        uuid not null references public.ic_whatsapp_quedas(id) on delete cascade,
  linha_id        uuid not null references public.vendedores_whatsapp(id) on delete cascade,
  telefone        text not null,
  nome            text,
  ultima_msg_em   timestamptz not null,
  cliente_crm_id  uuid references public.clientes_crm(id) on delete set null,
  estado          text not null default 'pendente'
                  check (estado in ('pendente', 'processando', 'enviada', 'ignorada', 'falhou')),
  motivo          text,
  processada_em   timestamptz,
  criado_em       timestamptz not null default now(),
  unique (queda_id, telefone)
);
comment on table public.ic_retomada_queda is 'IC: fila de quem mandou mensagem durante uma queda do WhatsApp; a IA retoma uma por vez. So service_role.';
create index if not exists ic_retomada_queda_pendente
  on public.ic_retomada_queda (criado_em) where estado = 'pendente';
alter table public.ic_retomada_queda enable row level security;
revoke all on public.ic_retomada_queda from public, anon, authenticated;

insert into public.crm_ia_config (chave, valor, descricao) values
  ('retomada_queda_ligada', 'true', 'IC: true = depois de uma queda do WhatsApp a IA retoma quem escreveu nesse periodo'),
  ('retomada_queda_intervalo_min', '3', 'IC: minutos entre uma retomada pos-queda e outra (1 a 60)'),
  ('retomada_queda_horario', '08:00-20:00', 'IC: janela local das retomadas pos-queda (nunca domingo)'),
  ('retomada_queda_desconhecidos', 'true', 'IC: true = tambem chama quem escreveu na queda e ainda nao tem card')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- drop table if exists public.ic_retomada_queda;
-- drop table if exists public.ic_whatsapp_quedas;
-- delete from public.crm_ia_config where chave in ('retomada_queda_ligada','retomada_queda_intervalo_min',
--   'retomada_queda_horario','retomada_queda_desconhecidos');
