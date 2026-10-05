// Roda os arquivos 00 a 24 em ordem numa base Postgres VAZIA, local, sem
// Supabase e sem rede (PGlite = Postgres 17 compilado para WebAssembly), e
// depois chama cada funcao do nucleo e cada funcao nova do IC CRM com
// cards de teste.
//
// O que o PGlite nao tem e e simulado no comeco: os papeis anon/authenticated/
// service_role, auth.uid(), auth.role(), auth.jwt() e a publicacao
// supabase_realtime. O arquivo 11 (pg_cron/pg_net) e pulado: essas extensoes so
// existem no Supabase (o 16 agenda seu job so se pg_cron existir).
//
//   mkdir pg && cd pg && npm init -y && npm i @electric-sql/pglite
//   cp <este arquivo> pg/ && node pg/testar-na-base-vazia.mjs <caminho/absoluto/de/supabase/sql>
//
// Rodadas:
//   1. superusuario + JWT de admin@teste.local: nucleo inteiro + funcoes ic_*.
//   2. JWT de vendedor@teste.local (perfil Vendedor, sem ve_dinheiro):
//      ic_pode_ver_dinheiro() = false e as RPCs de dinheiro sem valores.
//   3. "set role authenticated" (RLS de verdade) como vendedor e como admin:
//      escopo do card, tabelas so-admin, update da propria linha em users.
// Sai com codigo 1 se qualquer linha ERRO/FALHOU aparecer.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import fs from 'fs';
const B = process.argv[2];
if (!B) { console.log('uso: node testar-na-base-vazia.mjs <pasta supabase/sql>'); process.exit(1); }
const db = new PGlite({ extensions: { pg_trgm } });
let falhas = 0;
const falhou = (msg) => { falhas++; console.log('FALHOU ' + msg); };
const check = (nome, cond, extra) => { if (cond) console.log('ok     ' + nome + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 110) : '')); else falhou(nome + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 200) : '')); };
const r = async (q) => { try { const x = await db.query(q); return x.rows; } catch (e) { return 'ERRO: ' + e.message; } };
const ok = (x) => typeof x !== 'string';
const setJwt = async (email) => db.exec(`create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"${email}","role":"authenticated"}'::jsonb $$;`);

// Supabase que nao existe no Postgres puro
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function auth.role() returns text language sql as $$ select 'anon'::text $$;
create publication supabase_realtime;
`);
await setJwt('admin@teste.local');

const arquivos = fs.readdirSync(B).filter(f => /^\d\d_.*\.sql$/.test(f)).sort();
for (const f of arquivos) {
  if (f.startsWith('11_')) { console.log('PULADO (pg_cron/pg_net nao existem no PGlite):', f); continue; }
  let sql = fs.readFileSync(B + '/' + f, 'utf8');
  if (f.startsWith('12_')) sql = sql.replace(/'<NOME DO ADMIN>'/g, "'Admin Teste'").replace(/<email-do-admin@exemplo.com>/g, 'admin@teste.local').replace(/'<5511900000000>'/g, "'5511900000000'").replace(/'<PHONE_NUMBER_ID_DA_META>'/g, "'123456'");
  try { await db.exec(sql); console.log('ok  ', f); }
  catch (e) { console.log('ERRO', f, '->', e.message); process.exit(1); }
}
console.log('tabelas', (await r(`select count(*) from pg_tables where schemaname='public'`))[0]);
console.log('funcoes', (await r(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname !~ '^(gtrgm|gin_|similarity|word_similarity|strict_word|show_|set_limit|show_limit|gin_extract|gin_trgm|gtrgm)'`))[0]);

// ---------- fumaca do nucleo: dados de teste e uma chamada por funcao ----------
// (so no funil 'Atendimento Geral': com tres funis, o cross join antigo duplicava os ids)
const FG = `(select id from crm_funis where nome = 'Atendimento Geral')`;
await db.exec(`
insert into clientes_crm (id, nome, telefone, numero_whatsapp, etapa, vendedor_id, funil_id, origem, data_entrada, lead_chegou_em, ultima_mensagem_em, ultima_mensagem_direcao, anuncio_id, anuncio_titulo, anuncio_app)
select ('00000000-0000-0000-0000-00000000000'||n)::uuid, 'Teste '||n, '55119000000'||n, '55119000000'||n, 'cliente_novo', u.id, f.id, 'whatsapp', now() - (n||' days')::interval, now() - (n||' days')::interval, now() - (n||' hours')::interval, 'recebida', case when n=1 then 'AD1' end, case when n=1 then 'Anuncio' end, case when n=1 then 'meta_ads' end
from users u, crm_funis f, generate_series(1,3) n where f.nome = 'Atendimento Geral';
insert into crm_conversas (cliente_crm_id, vendedor_id, numero_lead, direcao, autor, mensagem, tipo, zapi_message_id, criada_em, payload_raw)
select c.id, c.vendedor_id, c.telefone, d.dir, case when d.dir='recebida' then 'lead' else 'vendedor' end, 'oi '||d.k, 'texto', 'wamid.'||c.nome||d.k, now() - (d.k||' hours')::interval,
  case when d.k=3 and c.anuncio_id is not null then '{"message":{"referral":{"source_type":"ad","source_id":"AD1","headline":"Anuncio"}}}'::jsonb end
from clientes_crm c cross join (values ('recebida',3),('enviada',2),('recebida',1)) d(dir,k);
insert into vendas (cliente_crm_id, valor, valor_pago, data_fechamento) values ('00000000-0000-0000-0000-000000000001', 1000, 1000, current_date);
update clientes_crm set etapa='fechado' where id='00000000-0000-0000-0000-000000000001';
`);
console.log('data_venda carimbada:', (await r(`select data_venda is not null v from clientes_crm where id='00000000-0000-0000-0000-000000000001'`))[0]);
const ini = "current_date - 30", fim = "current_date";
const chamadas = [
 `select crm_leads_resumo(${ini}, ${fim}, null, null, null, null)`,
 `select * from crm_leads_lista(${ini}, ${fim}, null, null, null, null, null, 50, 0)`,
 `select crm_leads_entrada_diaria(${ini}, ${fim}, null, null)`,
 `select crm_leads_por_classe(${ini}, ${fim}, 'novo', null, null, 10)`,
 `select crm_atendimento_resumo(${ini}, ${fim}, null)`,
 `select * from crm_atendimento_leads(${ini}, ${fim}, null, null, 10)`,
 `select crm_jornada_resumo(${ini}, ${fim}, null, null)`,
 `select crm_jornada_secoes(${ini}, ${fim}, null, null)`,
 `select * from crm_acoes_dia(null, 10)`,
 `select crm_acao_adiar('00000000-0000-0000-0000-000000000002', 1)`,
 `select crm_engajamento(null, null)`,
 `select * from crm_buscar_ids('Teste')`,
 `select crm_cards_irmaos('00000000-0000-0000-0000-000000000001')`,
 `select crm_cpl_resumo(${ini}, ${fim}, null, null)`,
 `select mkt_anuncios_resumo(${ini}, ${fim}, null, null, 'anuncio', true)`,
 `select mkt_sem_anuncio_por_origem(${ini}, ${fim}, null, null)`,
 `select * from crm_analise_origem_conversao(null, null, null, null)`,
 `select * from crm_analise_origem_ranking(null, null, null, null)`,
 `select fn_crm_card_vivo_no_funil('11900000001', ${FG})`,
 `select fn_lead_prospectado('00000000-0000-0000-0000-000000000001')`,
 `select crm_lead_convertido('00000000-0000-0000-0000-000000000001')`,
 `select count(*) from crm_duplicados_grupos`, `select count(*) from crm_leads_cpl_base`, `select count(*) from vw_crm_entrada_parada`, `select count(*) from crm_analise_leads_base`,
 `select anuncio_source_type, anuncio_referral_extraido_em from clientes_crm where id='00000000-0000-0000-0000-000000000001'`,
 `select origem from clientes_crm limit 1`,
 `update clientes_crm set data_entrada = data_entrada - interval '1 day' where id='00000000-0000-0000-0000-000000000003' returning id`,
 `update clientes_crm set funil_id=${FG}, telefone='11 90000-0002' where id='00000000-0000-0000-0000-000000000003' returning telefone_norm`,
];
for (const q of chamadas) {
  const x = await r(q);
  console.log((typeof x === 'string' ? 'FALHOU ' : 'ok     ') + q.slice(0, 70) + (typeof x === 'string' ? '\n        ' + x : '  -> ' + JSON.stringify(x).slice(0, 110)));
  if (!ok(x)) falhas++;
}
// mescla de verdade: card antigo (anterior ao marco do indice) + card novo, mesma pessoa e funil
await db.exec(`insert into clientes_crm (id, nome, telefone, etapa, vendedor_id, funil_id, created_at, data_entrada, origem)
  select '00000000-0000-0000-0000-000000000009'::uuid, 'Antigo', '5511900000002', 'cliente_novo', vendedor_id, funil_id, '2026-01-01', '2026-01-01', 'indicacao' from clientes_crm where id='00000000-0000-0000-0000-000000000002';
  insert into crm_conversas (cliente_crm_id, vendedor_id, numero_lead, direcao, autor, mensagem, tipo) values ('00000000-0000-0000-0000-000000000009','x','5511900000002','recebida','lead','antiga','texto');`);
console.log('grupos duplicados:', JSON.stringify(await r(`select id, lote from crm_duplicados_grupos`)));
const mescla = await r(`select crm_mesclar_grupo('00000000-0000-0000-0000-000000000003', array['00000000-0000-0000-0000-000000000009']::uuid[], 'teste')`);
check('mescla', ok(mescla), mescla);
console.log('resumo:', JSON.stringify(await r(`select crm_mescla_resumo('00000000-0000-0000-0000-000000000003')`)).slice(0, 200));
const desm = await r(`select crm_desmesclar_grupo('00000000-0000-0000-0000-000000000003')`);
check('desmescla', ok(desm), desm);
check('conversas de volta no antigo', (await r(`select count(*)::int n from crm_conversas where cliente_crm_id='00000000-0000-0000-0000-000000000009'`))[0]?.n === 1);
const hd = await r(`delete from clientes_crm where id='00000000-0000-0000-0000-000000000009'`);
check('hard delete barrado', !ok(hd), String(hd).slice(0, 100));

// =====================================================================
// IC CRM: rodada 1 (admin)
// =====================================================================
console.log('\n----- IC CRM: funis, perfis, parametros -----');
const funis = await r(`select f.nome, array_agg(e.nome order by e.ordem) etapas from crm_funis f join crm_funil_etapas e on e.funil_id=f.id group by f.nome order by min(f.ordem)`);
check('3 funis (sem Funil EXEMPLO)', ok(funis) && funis.length === 3 && !funis.some(f => f.nome === 'Funil EXEMPLO'), ok(funis) ? funis.map(f => f.nome) : funis);
for (const f of (ok(funis) ? funis : [])) {
  const e = f.etapas; const n = e.length;
  check(`funil '${f.nome}': cliente_novo 1a, cliente_antigo penultima, fechado ultima`, e[0] === 'cliente_novo' && e[n - 2] === 'cliente_antigo' && e[n - 1] === 'fechado', e);
}
const perfis = await r(`select nome, rotulo, is_admin, ve_dinheiro from perfis_acesso order by ordem`);
check('4 perfis com rotulo', ok(perfis) && perfis.length === 4 && perfis.every(p => p.rotulo), perfis);
check('Admin e Financeiro veem dinheiro, Vendedor e SDR nao', ok(perfis) && perfis.find(p => p.nome === 'Admin')?.ve_dinheiro === true && perfis.find(p => p.nome === 'Financeiro')?.ve_dinheiro === true && perfis.find(p => p.nome === 'Vendedor')?.ve_dinheiro === false && perfis.find(p => p.nome === 'SDR')?.ve_dinheiro === false);
const perms = await r(`select p.nome, pm.tela_chave, pm.pode_visualizar, pm.pode_criar, pm.pode_editar from permissoes pm join perfis_acesso p on p.id=pm.perfil_id order by 1,2`);
check('permissoes padrao (12 linhas, sem view-leads para Vendedor)', ok(perms) && perms.length === 12 && !perms.some(x => x.nome === 'Vendedor' && x.tela_chave === 'view-leads'), ok(perms) ? perms.length : perms);
check('telas: 10, secoes Atendimento/Sistema', (await r(`select count(*)::int n, count(distinct secao)::int s from sistema_telas where secao in ('Atendimento','Sistema')`))[0]?.n === 10);
check('vendedores_whatsapp repontado para Atendimento Geral', (await r(`select count(*)::int n from vendedores_whatsapp vw join crm_funis f on f.id=vw.funil_id where f.nome='Atendimento Geral'`))[0]?.n === 1);
check('jornada_metas 8 chaves', (await r(`select count(*)::int n from jornada_metas`))[0]?.n === 8);
check('crm_ia_config 5 chaves, ligada=false', (await r(`select count(*)::int n, bool_and(case when chave='ligada' then valor='false' else true end) l from crm_ia_config`))[0]?.n === 5);
check('ic_feature_flags 4 seeds', (await r(`select count(*)::int n from ic_feature_flags`))[0]?.n === 4);

console.log('\n----- IC CRM: dinheiro e flags (admin) -----');
check('ic_usuario_atual() = Admin Teste', (await r(`select (ic_usuario_atual()).name n`))[0]?.n === 'Admin Teste');
check('ic_eh_admin() true', (await r(`select ic_eh_admin() v`))[0]?.v === true);
check('ic_perfil_nome() = Admin', (await r(`select ic_perfil_nome() v`))[0]?.v === 'Admin');
check('ic_pode_ver_dinheiro() true (admin)', (await r(`select ic_pode_ver_dinheiro() v`))[0]?.v === true);
check("ic_flag('ia_transcricao_audio') true", (await r(`select ic_flag('ia_transcricao_audio') v`))[0]?.v === true);
check("ic_flag('ia_pre_atendimento') false", (await r(`select ic_flag('ia_pre_atendimento') v`))[0]?.v === false);
check("ic_flag('nao_existe') false", (await r(`select ic_flag('nao_existe') v`))[0]?.v === false);
let x = await r(`select ic_atendimento_resumo(${ini}, ${fim}, null) j`);
check('ic_atendimento_resumo (admin) traz ticket_medio e dinheiro_omitido=false', ok(x) && x[0].j.dinheiro_omitido === false && (x[0].j.correlacao || []).every(c => 'ticket_medio' in c), ok(x) ? x[0].j.correlacao : x);
x = await r(`select ic_anuncios_resumo(${ini}, ${fim}, null, null, 'anuncio', true) j`);
check('ic_anuncios_resumo (admin, com dinheiro) dinheiro_omitido=false', ok(x) && x[0].j.dinheiro_omitido === false, ok(x) ? x[0].j.total : x);
x = await r(`select * from ic_origem_conversao(null, null, null, null)`);
check('ic_origem_conversao (admin) valor_total preenchido', ok(x) && x.length > 0 && x.every(l => l.valor_total !== null), x);

console.log('\n----- IC CRM: job dos 30 dias -----');
await db.exec(`insert into clientes_crm (id, nome, telefone, etapa, vendedor_id, funil_id, origem, data_entrada, created_at)
  select '00000000-0000-0000-0000-000000000011'::uuid, 'Parado 45 dias', '5511900000011', 'cliente_novo', u.id, ${FG}, 'whatsapp', now() - interval '45 days', now() - interval '45 days' from users u where email='admin@teste.local';
  insert into clientes_crm (id, nome, telefone, etapa, vendedor_id, funil_id, origem, data_entrada)
  select '00000000-0000-0000-0000-000000000012'::uuid, 'Parado 45 dias excluido', '5511900000012', 'cliente_novo', u.id, ${FG}, 'whatsapp', now() - interval '45 days' from users u where email='admin@teste.local';
  update clientes_crm set deleted_at = now() where id = '00000000-0000-0000-0000-000000000012';`);
x = await r(`select crm_reclassificar_antigos() n`);
check('crm_reclassificar_antigos() >= 1', ok(x) && x[0].n >= 1, x);
check('card de 45 dias foi para cliente_antigo', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000011'`))[0]?.etapa === 'cliente_antigo');
check('card excluido NAO foi movido', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000012'`))[0]?.etapa === 'cliente_novo');
check('card de 2 dias NAO foi movido', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000002'`))[0]?.etapa === 'cliente_novo');
x = await r(`select tipo, usuario_nome, etapa_anterior, etapa_nova from crm_historico where cliente_id='00000000-0000-0000-0000-000000000011'`);
check('crm_historico automatico gravado', ok(x) && x.length === 1 && x[0].tipo === 'automatico' && x[0].usuario_nome === 'Sistema' && x[0].etapa_nova === 'cliente_antigo', x);
check('ic_jobs_log tem a execucao', (await r(`select count(*)::int n from ic_jobs_log where job='crm_reclassificar_antigos'`))[0]?.n === 1);
check('ic_reclassificados_recentes() >= 1', (await r(`select ic_reclassificados_recentes() n`))[0]?.n >= 1);
check('segunda rodada do job = 0', (await r(`select crm_reclassificar_antigos() n`))[0]?.n === 0);

console.log('\n----- IC CRM: IA (consentimento, handoff, contexto) -----');
x = await r(`select * from ic_handoffs_pendentes()`);
check('ic_handoffs_pendentes() vazio no inicio', ok(x) && x.length === 0, x);
x = await r(`select ic_ia_contexto('00000000-0000-0000-0000-000000000002', 12) j`);
check('ic_ia_contexto: primeiro nome, funil, etapa, consentimento, mensagens', ok(x) && x[0].j.primeiro_nome === 'Teste' && x[0].j.funil === 'Atendimento Geral' && x[0].j.etapa === 'Lead Novo' && x[0].j.consentimento === 'pendente' && x[0].j.mensagens.length === 3, ok(x) ? x[0].j : x);
check('ic_ia_contexto nao traz cpf/email/profissao/anuncio/telefone', ok(x) && !['cpf', 'email', 'profissao', 'anuncio_id', 'telefone', 'nome'].some(k => k in x[0].j));
await db.exec(`insert into ia_consentimentos (cliente_crm_id, telefone_norm, status, texto_apresentado, respondido_em) values ('00000000-0000-0000-0000-000000000002', '11900000002', 'concedido', 'Posso te atender com ajuda de IA?', now());`);
check('consentimento concedido aparece no contexto', (await r(`select ic_ia_contexto('00000000-0000-0000-0000-000000000002') j`))[0]?.j.consentimento === 'concedido');
await db.exec(`insert into ia_decisoes_log (cliente_crm_id, etapa_pipeline, decisao, motivo, modelo, tokens_entrada, tokens_saida, latencia_ms, dados_enviados_resumo, resposta_enviada) values ('00000000-0000-0000-0000-000000000002', 'resposta', 'responder', 'saudacao', 'claude-sonnet-5-5', 300, 40, 900, '{"mensagens":3}', true);`);
check('respostas_ia conta no contexto', (await r(`select ic_ia_contexto('00000000-0000-0000-0000-000000000002') j`))[0]?.j.respostas_ia === 1);
x = await r(`select has_function_privilege('authenticated', 'public.ic_ia_contexto(uuid, integer)', 'execute') v`);
check('ic_ia_contexto sem execute para authenticated', ok(x) && x[0].v === false, x);

console.log('\n----- IC CRM: agendamentos -----');
const uid = (await r(`select id from users where email='admin@teste.local'`))[0].id;
x = await r(`select * from ic_agendamento_criar('00000000-0000-0000-0000-000000000002', now() + interval '1 day', now() + interval '1 day 1 hour', '${uid}', 'Consulta inicial', 'consulta', 'obs teste')`);
check('ic_agendamento_criar devolve a linha com telefone_lead e criado_por', ok(x) && x.length === 1 && x[0].telefone_lead === '551190000002' && x[0].criado_por === uid && x[0].status === 'pendente' && x[0].google_sync_status === 'desligado', ok(x) ? { tel: x[0]?.telefone_lead, por: x[0]?.criado_por, g: x[0]?.google_sync_status } : x);
const agId = ok(x) ? x[0].id : null;
check('card continua em cliente_novo antes de confirmar', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000002'`))[0]?.etapa === 'cliente_novo');
x = await r(`select * from ic_agendamento_status('${agId}', 'confirmado')`);
check("ic_agendamento_status('confirmado')", ok(x) && x[0].status === 'confirmado', ok(x) ? x[0]?.status : x);
check('card moveu para agendamento_pendente', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000002'`))[0]?.etapa === 'agendamento_pendente');
x = await r(`select tipo, etapa_anterior, etapa_nova from crm_historico where cliente_id='00000000-0000-0000-0000-000000000002' and tipo='automatico'`);
check('crm_historico automatico do agendamento', ok(x) && x.length === 1 && x[0].etapa_nova === 'agendamento_pendente', x);
x = await r(`select * from ic_handoffs_pendentes()`);
check('handoff agendamento_confirmado nasceu', ok(x) && x.length === 1 && x[0].motivo === 'agendamento_confirmado' && x[0].nome === 'Teste 2', x);
const hId = ok(x) && x[0] ? x[0].id : null;
check('confirmar de novo nao duplica handoff', ok(await r(`select ic_agendamento_status('${agId}', 'confirmado')`)) && (await r(`select count(*)::int n from ia_handoffs where atendido_em is null`))[0]?.n === 1);
x = await r(`select * from ic_handoff_atender('${hId}')`);
check('ic_handoff_atender marca atendido_por = Admin Teste', ok(x) && x[0].atendido_por === 'Admin Teste' && x[0].atendido_em, ok(x) ? x[0]?.atendido_por : x);
check('ic_handoffs_pendentes() vazio depois', (await r(`select count(*)::int n from ic_handoffs_pendentes()`))[0]?.n === 0);
x = await r(`select * from ic_agendamentos_lista(current_date, current_date + 3, null, null)`);
check('ic_agendamentos_lista traz o agendamento com nome/funil/etapa', ok(x) && x.length === 1 && x[0].nome === 'Teste 2' && x[0].funil_nome === 'Atendimento Geral' && x[0].etapa_label === 'Agendamento Pendente', ok(x) ? x[0] : x);
x = await r(`select * from ic_ultimas_mensagens(array(select id from clientes_crm))`);
check('ic_ultimas_mensagens (20) devolve uma linha por card com conversa', ok(x) && x.length >= 1 && x.every(l => l.exibicao), ok(x) ? x.length : x);
check('ic_agendamentos_lista filtra por status', (await r(`select count(*)::int n from ic_agendamentos_lista(current_date, current_date + 3, null, 'pendente')`))[0]?.n === 0);
// funil sem etapa de agendamento (Bariatrica): confirmar NAO move o card
await db.exec(`insert into clientes_crm (id, nome, telefone, etapa, vendedor_id, funil_id, origem)
  select '00000000-0000-0000-0000-000000000021'::uuid, 'Bariatrica 1', '5511900000021', 'avaliacao_inicial', u.id, f.id, 'whatsapp' from users u, crm_funis f where u.email='admin@teste.local' and f.nome='Cirurgia Bariátrica';`);
x = await r(`select id from ic_agendamento_criar('00000000-0000-0000-0000-000000000021', now() + interval '2 day', now() + interval '2 day 1 hour', '${uid}', 'Avaliacao', 'consulta', null)`);
await r(`select ic_agendamento_status('${ok(x) ? x[0].id : null}', 'confirmado')`);
check('funil sem etapa de agendamento: card nao se move', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000021'`))[0]?.etapa === 'avaliacao_inicial');
check('...mas o handoff nasce', (await r(`select count(*)::int n from ia_handoffs where cliente_crm_id='00000000-0000-0000-0000-000000000021' and motivo='agendamento_confirmado'`))[0]?.n === 1);
// card fechado nunca se move
x = await r(`select id from ic_agendamento_criar('00000000-0000-0000-0000-000000000001', now() + interval '3 day', now() + interval '3 day 1 hour', '${uid}', 'Retorno', 'retorno', null)`);
await r(`select ic_agendamento_status('${ok(x) ? x[0].id : null}', 'confirmado')`);
check('card fechado nao se move ao confirmar', (await r(`select etapa from clientes_crm where id='00000000-0000-0000-0000-000000000001'`))[0]?.etapa === 'fechado');
x = await r(`delete from agendamentos where id='${agId}' returning id`);
check('agendamentos: realtime na publicacao', (await r(`select count(*)::int n from pg_publication_tables where pubname='supabase_realtime' and tablename='agendamentos'`))[0]?.n === 1);
check('ic_minha_agenda_google() vazio (sem credencial)', (await r(`select count(*)::int n from ic_minha_agenda_google()`))[0]?.n === 0);

// =====================================================================
// IC CRM: exclusão de funil (21_ic_funis.sql), como Admin
// =====================================================================
console.log('\n----- IC CRM: exclusão de funil (RPC transacional, soft delete, só Admin) -----');
await setJwt('admin@teste.local');
const F_VAZIO = '11111111-1111-4111-8111-111111111111';
const F_CARDS = '22222222-2222-4222-8222-222222222222';
const F_WA = '33333333-3333-4333-8333-333333333333';
const F_CONF = '44444444-4444-4444-8444-444444444444';
const idAG = (await r(`select id from crm_funis where nome = 'Atendimento Geral'`))[0].id;
const etapasPadrao = (f, extra = '') => `insert into crm_funil_etapas (funil_id, nome, label, ordem) values ('${f}','cliente_novo','Lead Novo',1)${extra},('${f}','cliente_antigo','Lead Antigo',99),('${f}','fechado','Fechado',100);`;
await db.exec(`
  insert into crm_funis (id, nome, ativo, ordem) values ('${F_VAZIO}','Funil Vazio Teste',true,90),('${F_CARDS}','Funil Com Cards Teste',true,91),('${F_WA}','Funil Com WhatsApp Teste',true,92),('${F_CONF}','Funil Conflito Teste',true,93);
  ${etapasPadrao(F_VAZIO)}
  ${etapasPadrao(F_CARDS, ",('" + F_CARDS + "','etapa_so_deste_funil','Etapa só deste funil',2)")}
  ${etapasPadrao(F_WA)}
  ${etapasPadrao(F_CONF)}
`);
let fx;

fx = await r(`select ic_funil_resumo('${F_VAZIO}') j`);
check('resumo do funil vazio: 0 cards, não é o último, tem destinos', ok(fx) && fx[0].j.cards === 0 && fx[0].j.ultimo_ativo === false && fx[0].j.destinos.length >= 3 && !fx[0].j.destinos.some(d => d.id === F_VAZIO), ok(fx) ? { cards: fx[0].j.cards, destinos: fx[0].j.destinos.length } : fx);

fx = await r(`select ic_funil_excluir('${F_VAZIO}') j`);
check('exclui funil sem cards', ok(fx) && fx[0].j.ok === true && fx[0].j.cards_movidos === 0, fx);
fx = await r(`select ativo, excluido_em is not null excl, excluido_por from crm_funis where id = '${F_VAZIO}'`);
check('exclusão é lógica: linha preservada, ativo=false, excluido_em e excluido_por gravados', ok(fx) && fx.length === 1 && fx[0].ativo === false && fx[0].excl === true && fx[0].excluido_por === 'admin@teste.local', fx);
check('etapas do funil excluído ficam preservadas', (await r(`select count(*)::int n from crm_funil_etapas where funil_id = '${F_VAZIO}'`))[0].n === 3);
fx = await r(`select operacao from audit_log_critico where tabela = 'crm_funis' and registro_id = '${F_VAZIO}' and operacao = 'SOFT_DELETE'`);
check('Histórico de Alterações registra SOFT_DELETE do funil', ok(fx) && fx.length === 1, fx);
check('funil excluído some de ic_funil_resumo (não encontrado)', String(await r(`select ic_funil_resumo('${F_VAZIO}') j`)).includes('Funil não encontrado'));
check('excluir de novo falha com mensagem clara', String(await r(`select ic_funil_excluir('${F_VAZIO}') j`)).includes('Funil não encontrado'));
check('funil inexistente falha com mensagem clara', String(await r(`select ic_funil_excluir('99999999-9999-4999-8999-999999999999') j`)).includes('Funil não encontrado'));

// --- funil com cards: bloqueia, depois move e exclui ---
await db.exec(`
  insert into clientes_crm (id, nome, telefone, etapa, funil_id, vendedor_id, data_entrada) values
   ('aaaaaaaa-0000-4000-8000-000000000001','FC Etapa Estranha','5511955510001','etapa_so_deste_funil','${F_CARDS}','demo',now()),
   ('aaaaaaaa-0000-4000-8000-000000000002','FC Fechado','5511955510002','fechado','${F_CARDS}','demo',now()),
   ('aaaaaaaa-0000-4000-8000-000000000003','FC Perdido','5511955510003','perdido','${F_CARDS}','demo',now()),
   ('aaaaaaaa-0000-4000-8000-000000000004','FC Excluido Logico','5511955510004','cliente_novo','${F_CARDS}','demo',now());
  update clientes_crm set deleted_at = now() where id = 'aaaaaaaa-0000-4000-8000-000000000004';
`);
fx = await r(`select ic_funil_resumo('${F_CARDS}') j`);
check('resumo conta TODOS os cards (fechado, perdido e excluído logicamente)', ok(fx) && fx[0].j.cards === 4, ok(fx) ? fx[0].j.cards : fx);
fx = await r(`select ic_funil_excluir('${F_CARDS}') j`);
check('bloqueia funil com cards e diz quantos', typeof fx === 'string' && fx.includes('Este funil tem 4 card(s)') && fx.includes('Mova-os para outro funil antes de excluir'), fx);
check('o bloqueio não alterou nada (funil continua ativo)', (await r(`select ativo from crm_funis where id = '${F_CARDS}'`))[0].ativo === true);
fx = await r(`select ic_funil_excluir('${F_CARDS}', '${F_CARDS}') j`);
check('destino igual à origem é recusado', String(fx).includes('diferente do funil excluído'), fx);
fx = await r(`select ic_funil_excluir('${F_CARDS}', '99999999-9999-4999-8999-999999999999') j`);
check('destino inexistente é recusado', String(fx).includes('destino não encontrado'), fx);
fx = await r(`select ic_funil_excluir('${F_CARDS}', '${F_VAZIO}') j`);
check('destino já excluído é recusado', String(fx).includes('destino não encontrado'), fx);

fx = await r(`select ic_funil_excluir('${F_CARDS}', '${idAG}') j`);
check('Mover e excluir numa chamada', ok(fx) && fx[0].j.ok === true && fx[0].j.cards_movidos === 4 && fx[0].j.destino === 'Atendimento Geral', fx);
fx = await r(`select id::text, funil_id::text, etapa from clientes_crm where id::text like 'aaaaaaaa-0000-4000-8000-00000000000%' order by id`);
check('os 4 cards agora estão no destino', ok(fx) && fx.length === 4 && fx.every(c => c.funil_id === idAG), fx);
check('etapa que não existe no destino cai na primeira etapa dele', ok(fx) && fx[0].etapa === 'cliente_novo', fx && fx[0]);
check('fechado e perdido são mantidos', ok(fx) && fx[1].etapa === 'fechado' && fx[2].etapa === 'perdido', fx && [fx[1].etapa, fx[2].etapa]);
fx = await r(`select count(*)::int n from crm_historico where cliente_id::text like 'aaaaaaaa-0000-4000-8000-00000000000%' and descricao like 'Funil "Funil Com Cards Teste" excluído%'`);
check('linha do tempo dos cards ativos registra a movimentação (3 de 4; o excluído logicamente fica de fora)', ok(fx) && fx[0].n === 3, fx);
fx = await r(`select dados_depois->'_exclusao'->>'cards_movidos' mov, dados_depois->'_exclusao'->>'destino_nome' dest from audit_log_critico where tabela = 'crm_funis' and registro_id = '${F_CARDS}' and operacao = 'SOFT_DELETE'`);
check('auditoria do funil guarda destino e quantidade movida', ok(fx) && fx.length === 1 && fx[0].mov === '4' && fx[0].dest === 'Atendimento Geral', fx);
check('o funil excluído não aparece mais entre os ativos', (await r(`select count(*)::int n from crm_funis where id = '${F_CARDS}' and ativo is true and excluido_em is null`))[0].n === 0);

// --- número de WhatsApp vinculado: bloqueia; com destino, repontado ---
await db.exec(`insert into vendedores_whatsapp (vendedor_id, vendedor_nome, numero_whatsapp, ativo, funil_id, meta_phone_id) values ('demo','Demo','5511900000099',true,'${F_WA}','PHONE-TESTE-FUNIL')`);
fx = await r(`select ic_funil_excluir('${F_WA}') j`);
check('funil sem cards mas com número de WhatsApp vinculado também bloqueia', typeof fx === 'string' && fx.includes('número(s) de WhatsApp'), fx);
fx = await r(`select ic_funil_excluir('${F_WA}', '${idAG}') j`);
check('com destino, o número de WhatsApp é repontado (o webhook não cria cards no funil excluído)', ok(fx) && fx[0].j.numeros_whatsapp_repontados === 1, fx);
check('vendedores_whatsapp.funil_id agora é o destino', (await r(`select funil_id::text f from vendedores_whatsapp where meta_phone_id = 'PHONE-TESTE-FUNIL'`))[0].f === idAG);

// --- conflito de telefone no destino: aborta sem mexer em nada ---
await db.exec(`
  insert into clientes_crm (id, nome, telefone, etapa, funil_id, vendedor_id, data_entrada) values
   ('bbbbbbbb-0000-4000-8000-000000000001','Conflito Origem','5511955520001','cliente_novo','${F_CONF}','demo',now()),
   ('bbbbbbbb-0000-4000-8000-000000000002','Conflito Destino','5511955520001','cliente_novo','${idAG}','demo',now());
`);
fx = await r(`select ic_funil_excluir('${F_CONF}', '${idAG}') j`);
check('telefone já existente no destino aborta a movimentação com mensagem clara', typeof fx === 'string' && fx.includes('mesmo telefone') && fx.includes('Atendimento Geral'), fx);
check('o aborto não moveu o card nem excluiu o funil (transação)', (await r(`select (select funil_id::text from clientes_crm where id = 'bbbbbbbb-0000-4000-8000-000000000001') f, (select ativo from crm_funis where id = '${F_CONF}') a`))[0].f === F_CONF && (await r(`select ativo from crm_funis where id = '${F_CONF}'`))[0].ativo === true);

// --- último funil ativo ---
await db.exec(`create temp table _ativos as select id, ativo from crm_funis where excluido_em is null; update crm_funis set ativo = false where excluido_em is null and id <> '${idAG}';`);
fx = await r(`select ic_funil_excluir('${idAG}') j`);
check('o último funil ativo não pode ser excluído', typeof fx === 'string' && fx.includes('último funil ativo'), fx);
fx = await r(`select ic_funil_resumo('${idAG}') j`);
check('resumo sinaliza ultimo_ativo = true', ok(fx) && fx[0].j.ultimo_ativo === true, fx);
await db.exec(`update crm_funis f set ativo = a.ativo from _ativos a where f.id = a.id; drop table _ativos;`);
await db.exec(`delete from vendedores_whatsapp where meta_phone_id = 'PHONE-TESTE-FUNIL'`);

// --- permissão: Vendedor, sem RLS de role (JWT trocado) ---
await setJwt('vendedor@teste.local');
fx = await r(`select ic_funil_excluir('${F_CONF}') j`);
check('Vendedor não exclui funil (42501), nem recebe "sucesso com 0 linhas"', typeof fx === 'string' && fx.includes('Somente administradores'), fx);
fx = await r(`select ic_funil_resumo('${F_CONF}') j`);
check('Vendedor também não consulta o resumo de exclusão', typeof fx === 'string' && fx.includes('Somente administradores'), fx);
check('funil continua intacto depois da tentativa do Vendedor', (await r(`select ativo from crm_funis where id = '${F_CONF}'`))[0].ativo === true);
await setJwt('admin@teste.local');
await db.exec(`update crm_funis set ativo = false, excluido_em = now() where id = '${F_CONF}'; delete from clientes_crm where false;`);

// =====================================================================
// IC CRM: rodada 2 (Vendedor sem ve_dinheiro, ainda superusuario)
// =====================================================================
console.log('\n----- IC CRM: rodada 2, perfil Vendedor (JWT trocado) -----');
await db.exec(`insert into users (id, name, email, pw, perfil, perfil_id, status)
  select 'vend-teste-0001', 'Vendedor Teste', 'vendedor@teste.local', 'supabase_auth', 'Vendedor', p.id, 'ativo' from perfis_acesso p where p.nome='Vendedor';
  insert into clientes_crm (id, nome, telefone, etapa, vendedor_id, funil_id, origem)
  values ('00000000-0000-0000-0000-000000000031', 'Do Vendedor', '5511900000031', 'cliente_novo', 'vend-teste-0001', ${FG}, 'whatsapp');
  insert into clientes_crm (id, nome, telefone, etapa, vendedor_id, funil_id, origem)
  values ('00000000-0000-0000-0000-000000000032', 'Sem dono', '5511900000032', 'cliente_novo', null, ${FG}, 'whatsapp');`);
await setJwt('vendedor@teste.local');
check('ic_usuario_atual() = Vendedor Teste', (await r(`select (ic_usuario_atual()).name n`))[0]?.n === 'Vendedor Teste');
check('ic_eh_admin() false', (await r(`select ic_eh_admin() v`))[0]?.v === false);
check('ic_perfil_nome() = Vendedor', (await r(`select ic_perfil_nome() v`))[0]?.v === 'Vendedor');
check('ic_pode_ver_dinheiro() false (Vendedor)', (await r(`select ic_pode_ver_dinheiro() v`))[0]?.v === false);
x = await r(`select ic_atendimento_resumo(${ini}, ${fim}, null) j`);
check('ic_atendimento_resumo (Vendedor) SEM ticket_medio, dinheiro_omitido=true', ok(x) && x[0].j.dinheiro_omitido === true && (x[0].j.correlacao || []).length > 0 && (x[0].j.correlacao || []).every(c => !('ticket_medio' in c)), ok(x) ? x[0].j.correlacao : x);
check('crm_atendimento_resumo original intocada (ainda traz ticket_medio)', ((await r(`select crm_atendimento_resumo(${ini}, ${fim}, null) j`))[0]?.j.correlacao || []).some(c => 'ticket_medio' in c));
x = await r(`select ic_anuncios_resumo(${ini}, ${fim}, null, null, 'anuncio', true) j`);
check('ic_anuncios_resumo (Vendedor, pediu dinheiro) dinheiro_omitido=true e valor nulo', ok(x) && x[0].j.dinheiro_omitido === true && x[0].j.total.valor_atribuidos === null && (x[0].j.linhas || []).every(l => l.valor === null && l.gasto === null), ok(x) ? x[0].j.total : x);
x = await r(`select * from ic_origem_conversao(null, null, null, null)`);
check('ic_origem_conversao (Vendedor) valor_total nulo, contagens presentes', ok(x) && x.length > 0 && x.every(l => l.valor_total === null && l.recebidos !== null), x);
// 25: quem nao e Admin so muda nome/foto/iniciais da propria linha; pw nunca guarda senha.
x = await r(`update users set perfil = 'Admin', role = 'admin' where id = 'vend-teste-0001'`);
check('25: Vendedor NAO vira Admin sozinho', typeof x === 'string' && x.includes('so Admin altera'), x);
x = await r(`update users set name = 'Vendedor Teste 2' where id = 'vend-teste-0001' returning name`);
check('25: Vendedor muda o proprio nome', ok(x) && x[0]?.name === 'Vendedor Teste 2', x);
await r(`update users set name = 'Vendedor Teste' where id = 'vend-teste-0001'`);
await setJwt('admin@teste.local');
x = await r(`update users set pw = 'senha123' where id = 'vend-teste-0001'`);
check('25: users.pw recusa senha mesmo de Admin (so supabase_auth)', typeof x === 'string' && x.includes('users_pw_sem_senha'), x);
x = await r(`update users set status = 'inativo' where id = 'vend-teste-0001' returning status`);
check('25: Admin altera status de outro usuario', ok(x) && x[0]?.status === 'inativo', x);
await r(`update users set status = 'ativo' where id = 'vend-teste-0001'`);
await setJwt('ninguem@teste.local');
check('ic_pode_ver_dinheiro() false (e-mail sem linha em users)', (await r(`select ic_pode_ver_dinheiro() v`))[0]?.v === false);
await db.exec(`create or replace function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;`);
check('ic_pode_ver_dinheiro() false (nao autenticado)', (await r(`select ic_pode_ver_dinheiro() v`))[0]?.v === false);
check('ic_usuario_atual() nulo (nao autenticado)', (await r(`select (ic_usuario_atual()).id is null v`))[0]?.v === true);
await db.exec(`create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{"role":"service_role"}'::jsonb $$;`);
check('ic_pode_ver_dinheiro() true (service_role)', (await r(`select ic_pode_ver_dinheiro() v`))[0]?.v === true);

// =====================================================================
// IC CRM: rodada 3, RLS de verdade (set role authenticated)
// =====================================================================
console.log('\n----- IC CRM: rodada 3, RLS com set role authenticated -----');
// Fora do Supabase nao ha concessao padrao: concede tudo e deixa a RLS decidir.
await db.exec(`
grant usage on schema public, auth to anon, authenticated;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;
grant execute on all functions in schema auth to anon, authenticated;
grant select on all tables in schema public to anon;
grant insert on public.audit_log to anon;
`);
const totalCards = (await r(`select count(*)::int n from clientes_crm`))[0].n;
await setJwt('vendedor@teste.local');
await db.exec(`set role authenticated`);
check('[vend] ve so os proprios cards e os sem dono (2)', (await r(`select count(*)::int n from clientes_crm`))[0]?.n === 2, await r(`select nome, vendedor_id from clientes_crm`));
check('[vend] nao ve conversas dos cards do admin', (await r(`select count(*)::int n from crm_conversas`))[0]?.n === 0);
check('[vend] nao le vendedores_whatsapp', (await r(`select count(*)::int n from vendedores_whatsapp`))[0]?.n === 0);
check('[vend] nao le ic_google_credenciais', (await r(`select count(*)::int n from ic_google_credenciais`))[0]?.n === 0);
check('[vend] nao le audit_log_critico', (await r(`select count(*)::int n from audit_log_critico`))[0]?.n === 0);
check('[vend] nao le ia_decisoes_log', (await r(`select count(*)::int n from ia_decisoes_log`))[0]?.n === 0);
check('[vend] le funis, etapas, users, perfis, telas, flags', (await r(`select (select count(*) from crm_funis) + (select count(*) from crm_funil_etapas) + (select count(*) from users) + (select count(*) from perfis_acesso) + (select count(*) from sistema_telas) + (select count(*) from ic_feature_flags) > 20 v`))[0]?.v === true);
x = await r(`update users set name = 'Vendedor Renomeado' where email = 'vendedor@teste.local' returning name`);
check('[vend] atualiza a propria linha em users', ok(x) && x.length === 1, x);
x = await r(`update users set name = 'Hack' where email = 'admin@teste.local' returning name`);
check('[vend] NAO atualiza a linha do admin (0 linhas)', ok(x) && x.length === 0, x);
x = await r(`insert into perfis_acesso (nome) values ('Invasor') returning id`);
check('[vend] NAO cria perfil', !ok(x), String(x).slice(0, 80));
x = await r(`update ic_feature_flags set ligada = true where chave = 'ia_pre_atendimento' returning chave`);
check('[vend] NAO liga flag (0 linhas)', ok(x) && x.length === 0, x);
x = await r(`delete from crm_funis where nome = 'Atendimento Geral' returning id`);
check('[vend] delete direto em crm_funis afeta 0 linhas, sem erro (era o "excluir que não exclui")', ok(x) && x.length === 0, x);
check('[vend] o funil continua lá depois do delete bloqueado', (await r(`select count(*)::int n from crm_funis where nome = 'Atendimento Geral'`))[0].n === 1);
check('[vend] ic_funil_excluir negado com mensagem (não "0 linhas")', String(await r(`select ic_funil_excluir('${idAG}') j`)).includes('Somente administradores'));
x = await r(`update clientes_crm set etapa = 'em_conversa' where id = '00000000-0000-0000-0000-000000000031' returning etapa`);
check('[vend] move o proprio card (gatilhos de auditoria nao travam)', ok(x) && x.length === 1, x);
x = await r(`update clientes_crm set etapa = 'em_conversa' where id = '00000000-0000-0000-0000-000000000003' returning etapa`);
check('[vend] NAO move card do admin (0 linhas)', ok(x) && x.length === 0, x);
x = await r(`delete from crm_historico where cliente_id = '00000000-0000-0000-0000-000000000031' returning id`);
check('[vend] delete em crm_historico afeta 0 linhas (sem erro)', ok(x) && x.length === 0, x);
x = await r(`select crm_acoes_dia(null, 10) j`);
check('[vend] crm_acoes_dia (nucleo, invoker) roda sob RLS', ok(x), x);
x = await r(`select ic_atendimento_resumo(${ini}, ${fim}, null) j`);
check('[vend] ic_atendimento_resumo roda sob RLS e omite dinheiro', ok(x) && x[0].j.dinheiro_omitido === true, ok(x) ? x[0].j.topo : x);
x = await r(`select crm_leads_resumo(${ini}, ${fim}, null, null, null, null) j`);
check('[vend] crm_leads_resumo (nucleo) roda sob RLS', ok(x), x);
x = await r(`select * from ic_agendamento_criar('00000000-0000-0000-0000-000000000031', now() + interval '1 day', now() + interval '1 day 1 hour', 'vend-teste-0001', 'Consulta', 'consulta', null)`);
check('[vend] cria agendamento no proprio card', ok(x) && x[0].criado_por === 'vend-teste-0001', ok(x) ? x[0]?.criado_por : x);
x = await r(`select * from ic_agendamento_criar('00000000-0000-0000-0000-000000000003', now() + interval '1 day', now() + interval '1 day 1 hour', 'vend-teste-0001', 'Consulta', 'consulta', null)`);
check('[vend] NAO cria agendamento em card do admin', !ok(x) && String(x).includes('sem acesso'), String(x).slice(0, 80));
check('[vend] ic_agendamentos_lista so os seus (1)', (await r(`select count(*)::int n from ic_agendamentos_lista(current_date, current_date + 5, null, null)`))[0]?.n === 1);
x = await r(`select ic_ia_contexto('00000000-0000-0000-0000-000000000031') j`);
check('[vend] ic_ia_contexto negado (permission denied)', !ok(x), String(x).slice(0, 80));
x = await r(`insert into ia_handoffs (cliente_crm_id, motivo, detalhe) values ('00000000-0000-0000-0000-000000000031', 'manual', 'teste') returning id`);
check('[vend] abre handoff manual no proprio card', ok(x) && x.length === 1, x);
await db.exec(`reset role`);
await setJwt('admin@teste.local');
await db.exec(`set role authenticated`);
check('[admin] ve todos os cards', (await r(`select count(*)::int n from clientes_crm`))[0]?.n === totalCards, totalCards);
check('[admin] le vendedores_whatsapp (1)', (await r(`select count(*)::int n from vendedores_whatsapp`))[0]?.n === 1);
check('[admin] le audit_log_critico', (await r(`select count(*)::int n from audit_log_critico`))[0]?.n > 0);
check('[admin] ainda NAO le ic_google_credenciais (so service_role)', (await r(`select count(*)::int n from ic_google_credenciais`))[0]?.n === 0);
x = await r(`update ic_feature_flags set ligada = true, atualizada_por = 'admin@teste.local' where chave = 'agendamento_google' returning chave`);
check('[admin] liga flag', ok(x) && x.length === 1, x);
await db.exec(`insert into crm_funis (id, nome, ativo, ordem) values ('55555555-5555-4555-8555-555555555555','Funil RLS Teste',true,95)`);
x = await r(`select ic_funil_excluir('55555555-5555-4555-8555-555555555555') j`);
check('[admin] exclui funil pela RPC sob RLS (security definer)', ok(x) && x[0].j.ok === true, x);
check('[admin] a exclusão apareceu no Histórico de Alterações (o admin lê audit_log_critico)', ok(x = await r(`select count(*)::int n from audit_log_critico where tabela = 'crm_funis' and registro_id = '55555555-5555-4555-8555-555555555555' and operacao = 'SOFT_DELETE'`)) && x[0].n === 1, x);

// IC CRM: cadastro padronizado (23_ic_cadastro_padrao.sql): CPF, e-mail e origem validados no banco
{
  check('[cadastro] ic_cpf_valido aceita CPF válido formatado', (await r("select ic_cpf_valido('529.982.247-25') v"))[0].v === true);
  check('[cadastro] ic_cpf_valido aceita CPF válido só dígitos', (await r("select ic_cpf_valido('52998224725') v"))[0].v === true);
  check('[cadastro] ic_cpf_valido rejeita dígito verificador errado', (await r("select ic_cpf_valido('52998224724') v"))[0].v === false);
  check('[cadastro] ic_cpf_valido rejeita sequência repetida', (await r("select ic_cpf_valido('111.111.111-11') v"))[0].v === false);
  check('[cadastro] ic_cpf_valido rejeita tamanho errado e nulo', (await r("select ic_cpf_valido('123') a, ic_cpf_valido(null) b"))[0].a === false);
  const m = await r("select ic_origem_chave('Indicação') a, ic_origem_chave('Importação manual') b, ic_origem_chave('Lista/Prospecção') c, ic_origem_chave('WhatsApp') d, ic_origem_chave('Google Ads') e, ic_origem_chave('Panfleto') f, ic_origem_chave('Anúncio') g");
  check('[cadastro] ic_origem_chave: mapeamento explícito', ok(m) && m[0].a === 'indicacao' && m[0].b === 'importacao' && m[0].c === 'lista_prospeccao' && m[0].d === 'whatsapp' && m[0].e === 'anuncio' && m[0].f === null && m[0].g === 'anuncio', m);
  check('[cadastro] ic_email_valido', (await r("select ic_email_valido('a@b.com') a, ic_email_valido('A@b.com') b, ic_email_valido('a@b') c"))[0].a === true);
  const cli = await r("select id from clientes_crm order by created_at limit 1");
  if (ok(cli) && cli.length) {
    const id = cli[0].id;
    let x = await r("update clientes_crm set cpf = '529.982.247-25' where id = '" + id + "' returning cpf");
    check('[cadastro] gravar CPF com máscara guarda só 11 dígitos', ok(x) && x[0].cpf === '52998224725', x);
    x = await r("update clientes_crm set cpf = '529.982.247-24' where id = '" + id + "' returning cpf");
    check('[cadastro] CPF inválido é REJEITADO pelo banco (não só pelo front)', typeof x === 'string' && x.includes('CPF inválido'), x);
    check('[cadastro] CPF anterior continua depois da rejeição', (await r("select cpf from clientes_crm where id = '" + id + "'"))[0].cpf === '52998224725');
    x = await r("update clientes_crm set cpf = '111.111.111-11' where id = '" + id + "' returning cpf");
    check('[cadastro] sequência repetida rejeitada', typeof x === 'string' && x.includes('CPF inválido'), x);
    x = await r("update clientes_crm set cpf = '' where id = '" + id + "' returning cpf");
    check('[cadastro] CPF vazio vira NULL', ok(x) && x[0].cpf === null, x);
    x = await r("update clientes_crm set email = '  Fulano@Exemplo.COM ' where id = '" + id + "' returning email");
    check('[cadastro] e-mail é aparado e vai para minúsculo', ok(x) && x[0].email === 'fulano@exemplo.com', x);
    x = await r("update clientes_crm set email = 'sem-arroba' where id = '" + id + "' returning email");
    check('[cadastro] e-mail inválido rejeitado', typeof x === 'string' && x.includes('E-mail inválido'), x);
    x = await r("update clientes_crm set origem = 'Indicação' where id = '" + id + "' returning origem");
    check('[cadastro] origem legada vira chave estável (indicacao)', ok(x) && x[0].origem === 'indicacao', x);
    x = await r("update clientes_crm set origem = 'Google Ads' where id = '" + id + "' returning origem");
    check('[cadastro] origem do webhook (Google Ads) mapeia para anuncio', ok(x) && x[0].origem === 'anuncio', x);
    x = await r("update clientes_crm set origem = 'Panfleto no ônibus' where id = '" + id + "' returning origem");
    check('[cadastro] origem desconhecida vira manual (e a constraint nunca é violada)', ok(x) && x[0].origem === 'manual', x);
    x = await r("update clientes_crm set telefone = '5511984567712' where id = '" + id + "' returning telefone");
    check('[cadastro] telefone continua em E.164 sem + (webhook depende disso)', ok(x) && x[0].telefone === '5511984567712', x);
  } else check('[cadastro] existe cliente para testar', false, cli);
  if (ok(cli) && cli.length) {
    const id2 = cli[0].id;
    let y = await r("update clientes_crm set nome = repeat('a', 201) where id = '" + id2 + "' returning id");
    check('[limites] nome com 201 caracteres é rejeitado pelo banco', typeof y === 'string' && y.includes('ic_clientes_nome_tam'), y);
    y = await r("update clientes_crm set nome = repeat('a', 200) where id = '" + id2 + "' returning length(nome) n");
    check('[limites] nome com 200 caracteres passa', ok(y) && y[0].n === 200, y);
    y = await r("update clientes_crm set observacoes = repeat('a', 5001) where id = '" + id2 + "' returning id");
    check('[limites] observações com 5001 caracteres rejeitadas', typeof y === 'string' && y.includes('ic_clientes_observacoes_tam'), y);
    y = await r("update clientes_crm set profissao = repeat('a', 101) where id = '" + id2 + "' returning id");
    check('[limites] profissão com 101 caracteres rejeitada', typeof y === 'string' && y.includes('ic_clientes_profissao_tam'), y);
  }
  const cs = await r("select conname from pg_constraint where conrelid = 'public.clientes_crm'::regclass and conname in ('ic_clientes_cpf_valido','ic_clientes_email_valido','ic_clientes_origem_oficial') order by 1");
  check('[cadastro] as 3 constraints existem', ok(cs) && cs.length === 3, cs);
  check('[cadastro] tabelas de cópia e pendências têm RLS (dado pessoal)', (await r("select count(*)::int n from pg_tables where schemaname='public' and tablename in ('ic_bkp23_cadastro','ic_cadastro_pendencias') and rowsecurity"))[0].n === 2);
}

check('[admin] ic_flag reflete', (await r(`select ic_flag('agendamento_google') v`))[0]?.v === true);
x = await r(`insert into sistema_telas (id, nome, secao) values ('view-nova', 'Nova', 'Sistema') returning id`);
check('[admin] registra tela nova (detectarERegistrarTelasNovas)', ok(x) && x.length === 1, x);
check('[admin] ve handoffs pendentes de todos', (await r(`select count(*)::int n from ic_handoffs_pendentes()`))[0]?.n >= 2);
await db.exec(`reset role`);
await setJwt('anon-nao-tem-email@nada');
await db.exec(`create or replace function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$; set role anon;`);
check('[anon] nao le clientes_crm', (await r(`select count(*)::int n from clientes_crm`))[0]?.n === 0);
check('[anon] nao le users', (await r(`select count(*)::int n from users`))[0]?.n === 0);
check('[anon] nao le crm_funis', (await r(`select count(*)::int n from crm_funis`))[0]?.n === 0);
// sem RETURNING: devolver a linha exige SELECT, e anon nao tem (o front usa .insert() sem .select(), return=minimal)
x = await r(`insert into audit_log (user_email, acao) values ('x@y.z', 'login_falhou')`);
check('[anon] grava login_falhou em audit_log (sem returning)', ok(x), x);
x = await r(`insert into audit_log (user_email, acao) values ('x@y.z', 'login_falhou') returning id`);
check('[anon] ...mas nao le de volta (returning negado)', !ok(x), String(x).slice(0, 80));
await db.exec(`reset role`);

check('auditoria (16) em users gravou em audit_log_critico (insert + update do vendedor)', (await r(`select count(*)::int n from audit_log_critico where tabela = 'users'`))[0]?.n >= 2);

console.log('\n----- pg_policies: politicas abertas para public que sobraram -----');
console.log(JSON.stringify(await r(`select tablename, policyname, cmd from pg_policies where schemaname='public' and roles='{public}' order by 1,2`)));
check('so audit_log tem politica para public', (await r(`select count(*)::int n from pg_policies where schemaname='public' and roles='{public}' and tablename <> 'audit_log'`))[0]?.n === 0);
check('toda tabela do public tem RLS ligada', (await r(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`))[0]?.n === 0, await r(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`));

console.log('\n' + (falhas ? `FALHOU: ${falhas} verificacao(oes)` : 'TUDO PASSOU'));
process.exit(falhas ? 1 : 0);
