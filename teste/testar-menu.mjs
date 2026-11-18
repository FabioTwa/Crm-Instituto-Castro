// Testes da lista única de itens de menu (ic-menu.js). Sem dependências: node teste/testar-menu.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const M = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ic-menu.js'));

let falhas = 0, total = 0;
function igual(nome, obtido, esperado) {
    total++;
    const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
    if (!ok) falhas++;
    console.log((ok ? 'ok     ' : 'FALHOU ') + nome + (ok ? '' : '  obtido=' + JSON.stringify(obtido) + ' esperado=' + JSON.stringify(esperado)));
}
const ids = (lista) => lista.map((i) => i.id);

const ADMIN = { admin: true };
// Atendente da demonstração: Ações do Dia, Pipeline e Agendamentos (sem Leads e sem Sistema).
const ATENDENTE = { admin: false, permitidas: ['view-acoes-dia', 'view-crm', 'view-agendamentos'] };
const RECEPCAO = { admin: false, permitidas: ['view-leads', 'view-crm', 'view-usuarios'] };
const VAZIO = { admin: false, permitidas: [] };

// ---- ordem do menu do computador (fonte da barra e da folha)
igual('ordem do menu lateral', ids(M.ITENS), ['leads', 'acoes-dia', 'crm', 'agendamentos', 'whatsapp', 'usuarios', 'permissoes', 'redistribuir-leads', 'audit-log', 'meu-perfil']);

// ---- barra: ordem aprovada e sem buraco
igual('barra do admin na ordem aprovada', ids(M.itensBarra(ADMIN)), ['crm', 'leads', 'acoes-dia', 'agendamentos']);
igual('barra mostra os nomes curtos', M.itensBarra(ADMIN).map((i) => i.curto), ['Pipeline', 'Leads', 'Ações do Dia', 'Agendamentos']);
igual('barra: item sem acesso some (atendente sem Leads)', ids(M.itensBarra(ATENDENTE)), ['crm', 'acoes-dia', 'agendamentos']);
igual('barra: recepção só com Leads e Pipeline', ids(M.itensBarra(RECEPCAO)), ['crm', 'leads']);
igual('barra sem login fica vazia', ids(M.itensBarra(null)), []);
igual('barra com lista vazia de permissões fica vazia', ids(M.itensBarra(VAZIO)), []);
igual('barra nunca passa de 4 itens', M.itensBarra(ADMIN).length <= 4, true);

// ---- "Mais" por perfil: resto do menu na ordem do computador + Sair no fim
igual('mais do admin', ids(M.itensMais(ADMIN)), ['whatsapp', 'usuarios', 'permissoes', 'redistribuir-leads', 'audit-log', 'meu-perfil', 'sair']);
igual('mais do atendente: só perfil e sair', ids(M.itensMais(ATENDENTE)), ['meu-perfil', 'sair']);
igual('mais da recepção: usuários, perfil e sair', ids(M.itensMais(RECEPCAO)), ['usuarios', 'meu-perfil', 'sair']);
igual('mais com permissões vazias: perfil e sair', ids(M.itensMais(VAZIO)), ['meu-perfil', 'sair']);
igual('mais sem login fica vazio', ids(M.itensMais(null)), []);
igual('nenhum item fica na barra e no mais ao mesmo tempo', ids(M.itensMais(ADMIN)).filter((id) => M.BARRA.includes(id)), []);
igual('barra + mais = todo o menu visível + sair (admin)', [...ids(M.itensBarra(ADMIN)), ...ids(M.itensMais(ADMIN))].sort(), [...ids(M.ITENS), 'sair'].sort());

// ---- regra de acesso igual à do menu lateral
igual('admin vê tudo', ids(M.itensVisiveis(ADMIN)), ids(M.ITENS));
igual('meu perfil aparece sempre', M.podeVerTela('view-meu-perfil', ATENDENTE), true);
igual('whatsapp fora da lista não aparece', M.podeVerTela('view-whatsapp', ATENDENTE), false);
igual('sem login não vê nada', M.podeVerTela('view-crm', null), false);

// ---- item ativo, incluindo subtelas
igual('pipeline ativo', M.itemAtivo('view-crm'), 'crm');
igual('card completo acende pipeline', M.itemAtivo('view-crm-detalhe'), 'crm');
igual('funis acende pipeline', M.itemAtivo('view-pipelines'), 'crm');
igual('jornada do lead acende leads', M.itemAtivo('view-jornada-lead'), 'leads');
igual('análise de leads acende leads', M.itemAtivo('view-analise-leads'), 'leads');
igual('histórico ativo', M.itemAtivo('view-audit-log'), 'audit-log');
igual('login não acende nada', M.itemAtivo('view-login'), null);

// ---- "Mais" ativo
igual('mais acende em Usuários (admin)', M.maisAtivo('view-usuarios', ADMIN), true);
igual('mais acende em Meu Perfil (atendente)', M.maisAtivo('view-meu-perfil', ATENDENTE), true);
igual('mais apagado no pipeline', M.maisAtivo('view-crm', ADMIN), false);
igual('mais apagado no card completo (é do pipeline)', M.maisAtivo('view-crm-detalhe', ADMIN), false);
igual('mais apagado em tela sem item', M.maisAtivo('view-login', ADMIN), false);
igual('mais apagado sem login', M.maisAtivo('view-usuarios', null), false);

// ---- menu lateral gerado do mesmo módulo
const lateral = M.htmlLateral();
igual('lateral tem os ids de sempre', (lateral.match(/id="nav-[a-z-]+"/g) || []).map((s) => s.slice(8, -1)),
    ['leads', 'acoes-dia', 'crm', 'agendamentos', 'whatsapp', 'usuarios', 'permissoes', 'redistribuir-leads', 'audit-log', 'meu-perfil']);
igual('lateral tem os dois grupos', (lateral.match(/id="sg-[a-z]+"/g) || []), ['id="sg-vendas"', 'id="sg-sistema"']);
igual('lateral mantém a bolinha do WhatsApp', lateral.includes('id="ic-wa-bolinha"'), true);
igual('lateral usa o nome completo do pipeline', lateral.includes('CRM / Pipeline'), true);

console.log('\n' + (total - falhas) + ' de ' + total + ' verificações passaram');
process.exit(falhas ? 1 : 0);
