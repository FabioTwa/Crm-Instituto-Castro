-- DADOS FICTÍCIOS DE TESTE (modo demonstração local). Nenhuma pessoa real.
-- Os placeholders __ADMIN_EMAIL__, __ADMIN_NOME__, __ATEND_EMAIL__ e __ATEND_NOME__
-- são trocados por demo-local.js com os valores do config.js local.
begin;

-- Ids de funil estáveis no demo (o banco é recriado a cada carga): permite provar #/pipeline?funil=<id> no F5.
-- Só existe aqui; em produção os ids são os do banco real.
set local session_replication_role = replica;
create temp table _fmap on commit drop as
  select id as antigo, ('00000000-0000-4000-8000-0000000001' || lpad((row_number() over (order by ordem, nome))::text, 2, '0'))::uuid as novo
  from public.crm_funis;
update public.crm_funil_etapas e set funil_id = m.novo from _fmap m where e.funil_id = m.antigo;
update public.vendedores_whatsapp v set funil_id = m.novo from _fmap m where v.funil_id = m.antigo;
update public.crm_funis f set id = m.novo from _fmap m where f.id = m.antigo;
set local session_replication_role = origin;

insert into public.users (id, name, email, pw, perfil, perfil_id, status)
select v.id, v.nome, v.email, 'supabase_auth', v.perfil, p.id, 'ativo'
from (values
  ('demo-admin', '__ADMIN_NOME__',  '__ADMIN_EMAIL__',            'Admin'),
  ('demo-diego', '__ATEND_NOME__',  '__ATEND_EMAIL__',            'Vendedor'),
  ('demo-ana',   'Ana Paula',       'ana.paula@exemplo.invalid',  'Vendedor'),
  ('demo-rec',   'Marta Recepção',  'recepcao@exemplo.invalid',   'SDR'),
  ('demo-fin',   'Paulo Financeiro','financeiro@exemplo.invalid', 'Financeiro')
) v(id, nome, email, perfil)
join public.perfis_acesso p on p.nome = v.perfil;

-- Cards. etapa = chave técnica; vendedor_id = users.id
create temp table _c (n int, nome text, tel text, funil text, etapa text, origem text, anuncio text, valor numeric, pago numeric, vend text, dias_entrada int, min_ultima int, dir text, msg text);
insert into _c values
 (1,'Juliana Ferreira','5511982214470','Atendimento Geral','cliente_novo','whatsapp',null,0,0,'demo-ana',1,12,'recebida','Vi o anúncio da cirurgia bariátrica, vocês atendem plano de saúde?'),
 (2,'Roberto Nascimento','5521973451182','Atendimento Geral','cliente_novo','Indicação',null,0,0,'demo-ana',2,38,'recebida','Minha prima fez a avaliação com vocês e indicou, queria saber como funciona'),
 (3,'Patrícia Gomes','5531998120033','Atendimento Geral','cliente_novo','whatsapp','24902',0,0,'demo-ana',1,60,'recebida','Olá, gostaria de mais informações sobre a assessoria em emagrecimento'),
 (4,'Carlos Eduardo Lima','5511988772201','Atendimento Geral','em_conversa','whatsapp',null,450,0,'demo-diego',6,120,'recebida','Qual o valor da consulta de avaliação nutricional?'),
 (5,'Fernanda Ribeiro','5541994567788','Atendimento Geral','em_conversa','Importação',null,1200,0,'demo-diego',9,180,'recebida','Ainda estou decidindo, mas gostaria de entender o pós-operatório'),
 (6,'Marcos Teixeira','5519981234455','Atendimento Geral','em_conversa','whatsapp',null,0,0,'demo-diego',4,300,'recebida','Vocês têm horário disponível nas tardes de sábado?'),
 (7,'Beatriz Lima','5511970118820','Atendimento Geral','negociacao','whatsapp','24871',3200,0,'demo-diego',20,20,'recebida','Adorei a proposta, só preciso falar com meu marido antes de confirmar'),
 (8,'Henrique Alves','5585987651230','Atendimento Geral','negociacao','whatsapp',null,8500,0,'demo-diego',12,60,'recebida','Podem fazer um desconto para pagamento à vista?'),
 (9,'Camila Duarte','5511992335567','Atendimento Geral','negociacao','Indicação',null,2400,0,'demo-ana',15,240,'enviada','Perfeito, aguardo o contato da recepção'),
 (10,'Rodrigo Pires','5511984567712','Atendimento Geral','agendamento_pendente','whatsapp',null,600,0,'demo-ana',8,30,'recebida','Confirmo presença dia 14, só preciso saber o endereço'),
 (11,'Letícia Monteiro','5521976543321','Atendimento Geral','agendamento_pendente','whatsapp','24871',0,0,'demo-diego',7,120,'recebida','Pode marcar para quinta de manhã?'),
 (12,'Mariana Souza','5511955443322','Atendimento Geral','fechado','whatsapp',null,4500,4500,'demo-diego',40,2880,'recebida','Muito obrigada, já fiz o pagamento!'),
 (13,'Paulo Ramos','5511944332211','Atendimento Geral','cliente_novo','Manual',null,0,0,'demo-ana',45,null,null,null),
 (14,'Sérgio Matos','5511933221100','Atendimento Geral','etapa_removida','Planilha',null,0,0,'demo-ana',10,null,null,null),
 (15,'Adriana Costa','5511966554433','Cirurgia Bariátrica','avaliacao_inicial','whatsapp','24871',18000,0,'demo-diego',5,90,'recebida','Quais exames preciso levar na avaliação?'),
 (16,'Eduardo Pinto','5511977665544','Cirurgia Bariátrica','negociacao_quente','Indicação',null,22000,0,'demo-diego',14,45,'recebida','Podemos parcelar em mais vezes?'),
 (17,'Vanessa Rocha','5511911223344','Assessoria em Emagrecimento','consulta_agendada','whatsapp','24902',1200,0,'demo-ana',3,200,'enviada','Combinado, te espero na terça às 10h');

insert into public.clientes_crm (id, nome, telefone, numero_whatsapp, etapa, origem, anuncio_id, anuncio_titulo, anuncio_app, valor, valor_pago, vendedor_id, vendedor_nome, funil_id, data_entrada, lead_chegou_em, ultima_mensagem_em, ultima_mensagem_direcao)
select ('00000000-0000-4000-8000-0000000000' || lpad(c.n::text, 2, '0'))::uuid, c.nome, c.tel, c.tel, c.etapa, c.origem,
       c.anuncio, case when c.anuncio is not null then 'Anúncio (teste)' end, case when c.anuncio is not null then 'meta_ads' end,
       c.valor, c.pago, c.vend, u.name, f.id, now() - (c.dias_entrada || ' days')::interval, now() - (c.dias_entrada || ' days')::interval,
       case when c.min_ultima is not null then now() - (c.min_ultima || ' minutes')::interval end, c.dir
from _c c join public.crm_funis f on f.nome = c.funil join public.users u on u.id = c.vend;

-- Conversas: uma mensagem do lead (ou da equipe) por card
insert into public.crm_conversas (cliente_crm_id, vendedor_id, numero_lead, direcao, autor, mensagem, tipo, zapi_message_id, criada_em)
select ('00000000-0000-4000-8000-0000000000' || lpad(c.n::text, 2, '0'))::uuid, c.vend, c.tel, c.dir,
       case when c.dir = 'recebida' then 'lead' else 'vendedor' end, c.msg, 'texto', 'wamid.DEMO' || c.n,
       now() - (c.min_ultima || ' minutes')::interval
from _c c where c.msg is not null and c.n <> 7;

-- Conversa completa da Beatriz (card 7): texto, resposta da equipe pelo celular (eco), áudio transcrito, mídia como placeholder
insert into public.crm_conversas (cliente_crm_id, vendedor_id, numero_lead, direcao, autor, mensagem, tipo, zapi_message_id, criada_em) values
 ('00000000-0000-4000-8000-000000000007','demo-diego','5511970118820','enviada','vendedor','Oi Beatriz! Vi que você comentou no anúncio, posso te explicar como funciona a bariátrica?','texto','wamid.DEMO7a', now() - interval '3 hours 40 minutes'),
 ('00000000-0000-4000-8000-000000000007','demo-diego','5511970118820','recebida','lead','Sim, por favor! Tenho muita vontade de fazer','texto','wamid.DEMO7b', now() - interval '3 hours 35 minutes'),
 ('00000000-0000-4000-8000-000000000007','demo-diego','5511970118820','enviada','vendedor','Perfeito! Nossa equipe faz uma avaliação completa antes, incluindo nutricionista e psicólogo. Vou te mandar os valores e as condições de pagamento.','audio','wamid.DEMO7c', now() - interval '3 hours 30 minutes'),
 ('00000000-0000-4000-8000-000000000007','demo-diego','5511970118820','recebida','lead','[Imagem recebida]','imagem','wamid.DEMO7d', now() - interval '3 hours 20 minutes'),
 ('00000000-0000-4000-8000-000000000007','demo-diego','5511970118820','enviada','vendedor','Recebido! Vou analisar e te retorno ainda hoje.','texto','wamid.DEMO7e', now() - interval '3 hours 10 minutes'),
 ('00000000-0000-4000-8000-000000000007','demo-diego','5511970118820','recebida','lead','Adorei a proposta, só preciso falar com meu marido antes de confirmar','texto','wamid.DEMO7f', now() - interval '20 minutes');

-- Linha do tempo
insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo, created_at) values
 ('00000000-0000-4000-8000-000000000007', null, 'cliente_novo', 'Sistema', 'Card criado via WhatsApp', 'criacao', now() - interval '20 days'),
 ('00000000-0000-4000-8000-000000000007', null, null, 'Sistema', 'Reativado automaticamente após novo contato (card havia sido excluído anteriormente)', 'reativacao', now() - interval '19 days 23 hours'),
 ('00000000-0000-4000-8000-000000000007', 'cliente_novo', 'em_conversa', 'Ana Paula', 'Movido de "Lead Novo" para "Em Conversa"', 'etapa', now() - interval '18 days'),
 ('00000000-0000-4000-8000-000000000007', 'em_conversa', 'negociacao', '__ATEND_NOME__', 'Movido de "Em Conversa" para "Negociação"', 'etapa', now() - interval '5 days'),
 ('00000000-0000-4000-8000-000000000007', null, null, '__ATEND_NOME__', 'Mensagem-chave: perguntou sobre desconto à vista', 'anotacao', now() - interval '4 days');
update public.clientes_crm set observacoes = 'Prefere contato à tarde. Decide junto com o marido.' where id = '00000000-0000-4000-8000-000000000007';

-- Jornada: lead criado de cada card
insert into public.crm_eventos_jornada (cliente_id, funil_id, vendedor_id, tipo_evento, created_at)
select id, funil_id, vendedor_id, 'lead_criado', data_entrada from public.clientes_crm;

-- Agendamentos (o gatilho move o card e abre handoff ao confirmar)
insert into public.agendamentos (cliente_crm_id, funil_id, responsavel_id, responsavel_nome, titulo, inicio, fim, status, tipo, telefone_lead, origem, google_sync_status)
select c.id, c.funil_id, c.vendedor_id, c.vendedor_nome, a.titulo,
       date_trunc('day', now()) + (a.dia || ' days')::interval + a.hora::interval,
       date_trunc('day', now()) + (a.dia || ' days')::interval + a.hora::interval + interval '30 minutes',
       'pendente', 'consulta', c.telefone, a.origem, 'desligado'
from (values
  ('00000000-0000-4000-8000-000000000010'::uuid, 'Consulta / avaliação', 1, '09:00', 'manual'),
  ('00000000-0000-4000-8000-000000000011'::uuid, 'Avaliação — bariátrica', 2, '10:30', 'ia'),
  ('00000000-0000-4000-8000-000000000017'::uuid, 'Consulta de acompanhamento', 3, '14:00', 'manual')
) a(id, titulo, dia, hora, origem) join public.clientes_crm c on c.id = a.id;
update public.agendamentos set status = 'confirmado' where cliente_crm_id = '00000000-0000-4000-8000-000000000010';

-- Handoff da IA pendente (dúvida clínica)
insert into public.ia_handoffs (cliente_crm_id, motivo, detalhe)
values ('00000000-0000-4000-8000-000000000006', 'duvida_clinica', 'Lead perguntou se pode tomar a caneta durante o tratamento. A assistente não respondeu e passou para a equipe médica.');

-- Regra dos 30 dias (o card 13 está há 45 dias em cliente_novo)
select public.crm_reclassificar_antigos();

commit;
