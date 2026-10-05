-- 12 Parametros de EXEMPLO (nao sao dados reais)
--
-- O CRM nao abre sem estas linhas: sem perfil Admin ninguem ve tela nenhuma,
-- sem funil o Kanban nao tem coluna, sem numero cadastrado o webhook ignora a
-- mensagem. Todo valor aqui e EXEMPLO e esta marcado assim. Troque antes de
-- usar. Nenhum nome, telefone, id ou e-mail abaixo e real.
--
-- Rode DEPOIS de criar o primeiro usuario no Supabase Auth. Os valores entre <> sao obrigatorios.

begin;

-- 1. Perfis de acesso. 'Admin' com is_admin = true ve tudo e nao depende da
--    matriz de permissoes. is_sistema = true impede excluir pela tela.
insert into public.perfis_acesso (nome, descricao, cor, is_admin, is_sistema, ordem) values
  ('Admin',    'EXEMPLO: acesso total',             '#111827', true,  true, 0),
  ('Vendedor', 'EXEMPLO: atende os proprios leads', '#2563EB', false, true, 30);

-- 2. Catalogo de telas do CRM. O id e o id da <div class="view"> do front.
--    A funcao detectarERegistrarTelasNovas (front) tambem insere telas aqui
--    no primeiro login de Admin; ver 5-front/INDICE.md, "O que o recorte perde".
insert into public.sistema_telas (id, nome, secao, ordem) values
  ('view-crm',                'CRM',                     'Vendas',  3),
  ('view-leads',              'Leads',                   'Vendas',  40),
  ('view-acoes-dia',          'Ações do Dia',            'Vendas',  55),
  ('view-pipelines',          'Pipelines',               'Vendas',  15),
  ('view-usuarios',           'Usuários',                'Sistema', 13),
  ('view-permissoes',         'Permissões',              'Sistema', 14),
  ('view-redistribuir-leads', 'Redistribuir Leads',      'Sistema', 905),
  ('view-meu-perfil',         'Meu Perfil',              'Sistema', 920),
  ('view-audit-log',          'Histórico de Alterações', 'Sistema', 990)
on conflict (id) do nothing;

-- 3. O que o Vendedor ve (EXEMPLO). Admin nao precisa de linha aqui.
insert into public.permissoes (perfil_id, tela_chave, pode_visualizar, pode_criar, pode_editar)
select p.id, t.tela, true, t.cria, t.cria
from public.perfis_acesso p
cross join (values ('view-crm', true), ('view-leads', false), ('view-acoes-dia', false), ('view-meu-perfil', true)) t(tela, cria)
where p.nome = 'Vendedor';

-- 4. O primeiro usuario. O login tenta Supabase Auth primeiro; pw =
--    'supabase_auth' diz que a senha NAO mora nesta tabela (nunca grave senha
--    aqui: o login alternativo compara pw em texto puro).
insert into public.users (name, email, pw, perfil, perfil_id, status)
select '<NOME DO ADMIN>', '<email-do-admin@exemplo.com>', 'supabase_auth', 'Admin', p.id, 'ativo'
from public.perfis_acesso p where p.nome = 'Admin';

-- 5. Um funil de EXEMPLO. Tres chaves de etapa tem significado no codigo:
--    a PRIMEIRA (menor ordem) e onde o webhook cria o card novo;
--    'cliente_antigo' recebe, toda vez que alguem abre o Kanban, todo card
--    parado em 'cliente_novo' ha mais de 30 dias (em QUALQUER funil; regra do
--    front, _loadCRMImpl). Funil sem essa etapa perde esses cards da tela;
--    'fechado' e o card ganho (carimba data_venda, fica fora de Acoes do Dia,
--    a mescla nao tira o card de la). 'perdido' NAO e coluna: e um estado que
--    o botao "Marcar perda" grava e que as contagens tratam como ordem 0.
with f as (
  insert into public.crm_funis (nome, descricao, ordem, usuarios_permitidos)
  values ('Funil EXEMPLO', 'EXEMPLO: troque nome e etapas', 1, '[]')
  returning id
)
insert into public.crm_funil_etapas (funil_id, nome, label, cor, ordem)
select f.id, e.nome, e.label, e.cor, e.ordem from f
cross join (values
  ('cliente_novo',      'Lead Novo',   '#3B82F6', 1),
  ('cliente_antigo',    'Lead Antigo', '#9CA3AF', 2),
  ('em_conversa',       'Em conversa', '#F59E0B', 3),
  ('proposta',          'Proposta',    '#8B5CF6', 4),
  ('fechado',           'Fechado',     '#10B981', 5)
) e(nome, label, cor, ordem);

-- 6. O numero de WhatsApp que entra no CRM. O webhook acha o dono da
--    mensagem por meta_phone_id (o "Phone number ID" do painel da Meta, NAO
--    o telefone). Sem esta linha a mensagem chega e e ignorada.
--    zapi_instancia e zapi_token ficam nulos aqui. So preencha se for usar o
--    ENVIO pelo CRM (pelo Z-API; ver supabase/functions/LEIA-IC.md): o token da instancia mora
--    nesta coluna, no banco, e a RLS da tabela e aberta. Pense antes.
insert into public.vendedores_whatsapp (vendedor_id, vendedor_nome, numero_whatsapp, ativo, funil_id, meta_phone_id)
select u.id, u.name, '<5511900000000>', true, f.id, '<PHONE_NUMBER_ID_DA_META>'
from public.users u, public.crm_funis f
where u.email = '<email-do-admin@exemplo.com>' and f.nome = 'Funil EXEMPLO';

-- 7. Analise de conversa por IA: DESLIGADA. As tabelas existem porque Acoes
--    do Dia le a ultima analise se houver; a funcao que analisa nao veio.
insert into public.crm_ia_config (chave, valor, descricao) values
  ('ligada', 'false', 'EXEMPLO: a analise por IA ainda nao foi implementada')
on conflict (chave) do nothing;

-- 8. Metas da Jornada (EXEMPLO; ajuste ao seu ciclo).
insert into public.jornada_metas (chave, valor, descricao) values
  ('conversao_geral_pct',       10,  'EXEMPLO: meta de conversao geral, em %'),
  ('prazo_conversao_dias',      30,  'EXEMPLO: prazo esperado ate fechar'),
  ('lead_parado_alerta_dias',   7,   'EXEMPLO: card parado vira alerta'),
  ('lead_parado_critico_dias',  14,  'EXEMPLO: card parado vira critico'),
  ('sla_card_link_horas',       24,  'EXEMPLO: SLA entre etapas da jornada'),
  ('sla_link_dados_horas',      72,  'EXEMPLO'),
  ('sla_dados_contrato_horas',  120, 'EXEMPLO'),
  ('sla_contrato_pagto_horas',  168, 'EXEMPLO');

-- 9. Numeros da casa (opcional): telefone que conversa com o CRM e nunca
--    vira lead (o seu proprio celular de teste, por exemplo).
-- insert into public.crm_numeros_internos (telefone_norm, motivo) values ('<11900000000>', 'EXEMPLO: celular de teste');

commit;
