-- 13 IC: perfis, telas, permissoes, funis e parametros da clinica
-- IC CRM (Instituto Castro de Medicina), camada sobre o esquema base (00-12).
--
-- O que faz:
--   1. Estende perfis_acesso com `rotulo` (nome exibido) e `ve_dinheiro`
--      (unica fonte de verdade de quem ve valores; lida por ic_pode_ver_dinheiro
--      no arquivo 14).
--   2. Seed dos 4 perfis. Os NOMES TECNICOS (Admin, Vendedor, SDR, Financeiro)
--      sao preservados porque o front os tem escrito em 52 linhas; o que a
--      clinica ve e o `rotulo` (Administrador, Atendente, Recepcao, Financeiro).
--   3. Catalogo de telas do IC CRM (sistema_telas) e permissoes padrao por
--      perfil (permissoes).
--   4. Tres funis como DADO (crm_funis + crm_funil_etapas). Em todos:
--      cliente_novo e a primeira etapa (onde o webhook cria o card),
--      cliente_antigo e a penultima (recebe os cards parados ha 30 dias, ver
--      16_ic_jobs.sql) e fechado e a ultima (card ganho).
--   5. jornada_metas e crm_ia_config com valores de clinica.
--   6. Remove o 'Funil EXEMPLO' do 12, se existir.
--
-- NAO insere usuario nem numero de WhatsApp: ficam para a implantacao (bloco
-- comentado ao final mostra como).
-- Idempotente: pode rodar mais de uma vez.
-- Depende de: 02 (tabelas), 04 (FKs), 12 (opcional; convive com ele).

begin;

-- ---------------------------------------------------------------------------
-- 1. Colunas novas em perfis_acesso
-- ---------------------------------------------------------------------------
alter table public.perfis_acesso add column if not exists rotulo text;
alter table public.perfis_acesso add column if not exists ve_dinheiro boolean not null default false;

comment on column public.perfis_acesso.rotulo is 'IC: nome exibido na tela. O campo `nome` e a chave tecnica que o front compara (Admin, Vendedor, SDR, Financeiro).';
comment on column public.perfis_acesso.ve_dinheiro is 'IC: perfil pode ver valores monetarios. Lido por ic_pode_ver_dinheiro(); is_admin tambem libera.';

-- ---------------------------------------------------------------------------
-- 2. Perfis (nomes tecnicos preservados; rotulo e o que a clinica ve)
-- ---------------------------------------------------------------------------
insert into public.perfis_acesso (nome, rotulo, descricao, cor, is_admin, is_sistema, ve_dinheiro, ordem) values
  ('Admin',      'Administrador', 'Acesso total ao IC CRM',                              '#0E0E25', true,  true,  true,  0),
  ('Vendedor',   'Atendente',     'Atende os proprios leads no Kanban',                  '#2D6298', false, true,  false, 30),
  ('SDR',        'Recepção',      'Recepcao: ve todos os leads, agenda e cria cards',    '#0A828E', false, true,  false, 20),
  ('Financeiro', 'Financeiro',    'Ve valores e a lista de leads; nao edita o Kanban',   '#FEC42D', false, false, true,  40)
on conflict (nome) do update set
  rotulo      = excluded.rotulo,
  ve_dinheiro = excluded.ve_dinheiro,
  is_admin    = excluded.is_admin,
  descricao   = excluded.descricao,
  cor         = excluded.cor,
  updated_at  = now();

-- ---------------------------------------------------------------------------
-- 3. Telas do IC CRM. O id e o id da <div class="view"> do front.
-- ---------------------------------------------------------------------------
insert into public.sistema_telas (id, nome, secao, ordem) values
  ('view-crm',                'CRM / Pipeline',          'Atendimento', 10),
  ('view-leads',              'Leads',                   'Atendimento', 20),
  ('view-acoes-dia',          'Ações do Dia',            'Atendimento', 30),
  ('view-agendamentos',       'Agendamentos',            'Atendimento', 40),
  ('view-pipelines',          'Gerenciar Funis',         'Sistema',     100),
  ('view-usuarios',           'Usuários',                'Sistema',     110),
  ('view-permissoes',         'Permissões',              'Sistema',     120),
  ('view-redistribuir-leads', 'Redistribuir Leads',      'Sistema',     130),
  ('view-meu-perfil',         'Meu Perfil',              'Sistema',     900),
  ('view-audit-log',          'Histórico de Alterações', 'Sistema',     990)
on conflict (id) do update set nome = excluded.nome, secao = excluded.secao, ordem = excluded.ordem;

-- ---------------------------------------------------------------------------
-- 4. Permissoes padrao. Admin (is_admin) nao precisa de linha.
--    Idempotente: apaga as linhas desses perfis para essas telas e reinsere.
-- ---------------------------------------------------------------------------
delete from public.permissoes pm
using public.perfis_acesso p
where pm.perfil_id = p.id
  and p.nome in ('Vendedor', 'SDR', 'Financeiro')
  and pm.tela_chave in ('view-crm', 'view-leads', 'view-acoes-dia', 'view-agendamentos', 'view-meu-perfil');

insert into public.permissoes (perfil_id, tela_chave, pode_visualizar, pode_criar, pode_editar)
select p.id, t.tela, true, t.cria, t.edita
from public.perfis_acesso p
join (values
  -- Vendedor (Atendente)
  ('Vendedor',   'view-crm',          true,  true),
  ('Vendedor',   'view-acoes-dia',    false, false),
  ('Vendedor',   'view-agendamentos', true,  true),
  ('Vendedor',   'view-meu-perfil',   false, true),
  -- SDR (Recepcao)
  ('SDR',        'view-crm',          true,  false),
  ('SDR',        'view-acoes-dia',    false, false),
  ('SDR',        'view-agendamentos', true,  true),
  ('SDR',        'view-leads',        false, false),
  ('SDR',        'view-meu-perfil',   false, true),
  -- Financeiro
  ('Financeiro', 'view-leads',        false, false),
  ('Financeiro', 'view-crm',          false, false),
  ('Financeiro', 'view-meu-perfil',   false, true)
) t(perfil, tela, cria, edita) on t.perfil = p.nome
on conflict (perfil_id, tela_chave) do update set
  pode_visualizar = excluded.pode_visualizar,
  pode_criar      = excluded.pode_criar,
  pode_editar     = excluded.pode_editar,
  updated_at      = now();

-- ---------------------------------------------------------------------------
-- 5. Funil EXEMPLO do 12: sai. Antes, o numero de WhatsApp que apontava para
--    ele (FK sem cascade) passa a apontar para 'Atendimento Geral', criado
--    abaixo... entao o funil geral e criado primeiro.
-- ---------------------------------------------------------------------------
insert into public.crm_funis (nome, descricao, ordem, usuarios_permitidos)
select 'Atendimento Geral', 'Porta de entrada: todo lead novo cai aqui e e triado', 1, '[]'
where not exists (select 1 from public.crm_funis where nome = 'Atendimento Geral');

insert into public.crm_funil_etapas (funil_id, nome, label, cor, ordem)
select f.id, e.nome, e.label, e.cor, e.ordem
from public.crm_funis f
cross join (values
  ('cliente_novo',         'Lead Novo',             '#0294AD', 1),
  ('em_conversa',          'Em Conversa',           '#2D6298', 2),
  ('negociacao',           'Negociação',            '#FEC42D', 3),
  ('agendamento_pendente', 'Agendamento Pendente',  '#0A828E', 4),
  ('visita_confirmada',    'Visita Confirmada',     '#A3CC83', 5),
  ('cliente_antigo',       'Lead Antigo',           '#727586', 6),
  ('fechado',              'Fechado',               '#0E0E25', 7)
) e(nome, label, cor, ordem)
where f.nome = 'Atendimento Geral'
  and not exists (select 1 from public.crm_funil_etapas x where x.funil_id = f.id);

-- Funil EXEMPLO (12): repontar numeros e apagar (etapas vao em cascade).
update public.vendedores_whatsapp vw
set funil_id = (select id from public.crm_funis where nome = 'Atendimento Geral' limit 1)
where vw.funil_id in (select id from public.crm_funis where nome = 'Funil EXEMPLO');

update public.clientes_crm c
set funil_id = (select id from public.crm_funis where nome = 'Atendimento Geral' limit 1)
where c.funil_id in (select id from public.crm_funis where nome = 'Funil EXEMPLO');

delete from public.crm_funis where nome = 'Funil EXEMPLO';

-- Cirurgia Bariatrica
insert into public.crm_funis (nome, descricao, ordem, usuarios_permitidos)
select 'Cirurgia Bariátrica', 'Jornada do paciente de cirurgia bariatrica', 2, '[]'
where not exists (select 1 from public.crm_funis where nome = 'Cirurgia Bariátrica');

insert into public.crm_funil_etapas (funil_id, nome, label, cor, ordem)
select f.id, e.nome, e.label, e.cor, e.ordem
from public.crm_funis f
cross join (values
  ('cliente_novo',           'Lead Novo',              '#0294AD', 1),
  ('avaliacao_inicial',      'Avaliação Inicial',      '#2D6298', 2),
  ('negociacao_quente',      'Negociação Quente',      '#FEC42D', 3),
  ('documentacao_pendente',  'Documentação Pendente',  '#0A828E', 4),
  ('cliente_antigo',         'Lead Antigo',            '#727586', 5),
  ('fechado',                'Fechado',                '#0E0E25', 6)
) e(nome, label, cor, ordem)
where f.nome = 'Cirurgia Bariátrica'
  and not exists (select 1 from public.crm_funil_etapas x where x.funil_id = f.id);

-- Assessoria em Emagrecimento
insert into public.crm_funis (nome, descricao, ordem, usuarios_permitidos)
select 'Assessoria em Emagrecimento', 'Acompanhamento de emagrecimento', 3, '[]'
where not exists (select 1 from public.crm_funis where nome = 'Assessoria em Emagrecimento');

insert into public.crm_funil_etapas (funil_id, nome, label, cor, ordem)
select f.id, e.nome, e.label, e.cor, e.ordem
from public.crm_funis f
cross join (values
  ('cliente_novo',       'Lead Novo',          '#0294AD', 1),
  ('consulta_agendada',  'Consulta Agendada',  '#0A828E', 2),
  ('em_acompanhamento',  'Em Acompanhamento',  '#A3CC83', 3),
  ('cliente_antigo',     'Lead Antigo',        '#727586', 4),
  ('fechado',            'Fechado',            '#0E0E25', 5)
) e(nome, label, cor, ordem)
where f.nome = 'Assessoria em Emagrecimento'
  and not exists (select 1 from public.crm_funil_etapas x where x.funil_id = f.id);

-- ---------------------------------------------------------------------------
-- 6. Metas da Jornada (clinica). Se o 12 ja gravou, fica o que esta.
-- ---------------------------------------------------------------------------
insert into public.jornada_metas (chave, valor, descricao) values
  ('conversao_geral_pct',       15,  'IC: meta de conversao geral, em %'),
  ('prazo_conversao_dias',      21,  'IC: prazo esperado do primeiro contato ate fechar'),
  ('lead_parado_alerta_dias',   3,   'IC: card sem movimento vira alerta'),
  ('lead_parado_critico_dias',  7,   'IC: card sem movimento vira critico'),
  ('sla_card_link_horas',       24,  'IC: SLA do primeiro passo da jornada'),
  ('sla_link_dados_horas',      48,  'IC: SLA do segundo passo'),
  ('sla_dados_contrato_horas',  72,  'IC: SLA do terceiro passo'),
  ('sla_contrato_pagto_horas',  120, 'IC: SLA do ultimo passo')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- 7. IA de pre-atendimento: DESLIGADA ate a implantacao decidir (17_ic_ia.sql
--    acrescenta as outras chaves).
-- ---------------------------------------------------------------------------
insert into public.crm_ia_config (chave, valor, descricao) values
  ('ligada', 'false', 'IC: IA de pre-atendimento desligada por padrao')
on conflict (chave) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- IMPLANTACAO (nao roda aqui): primeiro usuario e numero de WhatsApp.
-- Crie o usuario no Supabase Auth ANTES; o e-mail abaixo tem de ser o mesmo.
-- pw = 'supabase_auth' diz que a senha NAO mora nesta tabela. Nunca grave
-- senha em users.pw.
-- ---------------------------------------------------------------------------
-- insert into public.users (name, email, pw, perfil, perfil_id, status)
-- select '<NOME DO ADMIN>', '<email-do-admin@clinica.com.br>', 'supabase_auth', 'Admin', p.id, 'ativo'
-- from public.perfis_acesso p where p.nome = 'Admin'
-- on conflict (email) do nothing;
--
-- O webhook acha o dono da mensagem por meta_phone_id (o "Phone number ID" do
-- painel da Meta, NAO o telefone). zapi_* ficam nulos (caminho legado).
-- insert into public.vendedores_whatsapp (vendedor_id, vendedor_nome, numero_whatsapp, ativo, funil_id, meta_phone_id)
-- select u.id, u.name, '<5511900000000>', true, f.id, '<PHONE_NUMBER_ID_DA_META>'
-- from public.users u, public.crm_funis f
-- where u.email = '<email-do-admin@clinica.com.br>' and f.nome = 'Atendimento Geral';

-- ROLLBACK:
-- begin;
-- delete from public.crm_funis where nome in ('Atendimento Geral', 'Cirurgia Bariátrica', 'Assessoria em Emagrecimento');
--   -- (crm_funil_etapas vai em cascade; antes, repontar clientes_crm.funil_id e vendedores_whatsapp.funil_id)
-- delete from public.permissoes pm using public.perfis_acesso p where pm.perfil_id = p.id and p.nome in ('Vendedor','SDR','Financeiro');
-- delete from public.sistema_telas where id in ('view-agendamentos');  -- as demais ja vinham do 12
-- delete from public.perfis_acesso where nome in ('SDR', 'Financeiro');  -- Admin e Vendedor vinham do 12
-- update public.perfis_acesso set rotulo = null, ve_dinheiro = false;
-- alter table public.perfis_acesso drop column if exists ve_dinheiro;
-- alter table public.perfis_acesso drop column if exists rotulo;
-- delete from public.jornada_metas where descricao like 'IC:%';
-- delete from public.crm_ia_config where chave = 'ligada' and descricao like 'IC:%';
-- commit;
