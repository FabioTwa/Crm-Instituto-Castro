// IC CRM: lista ÚNICA dos itens de menu.
//
// Usada pelo menu lateral do computador e pela barra de navegação do celular/tablet (ic-barra.js),
// para os dois nunca divergirem. Sem DOM e sem dependências: roda no navegador (window.IcMenu) e no
// Node (require), onde é testada por teste/testar-menu.mjs.
//
// Regra de acesso (a mesma que o menu lateral sempre usou em aplicarPermissoesSidebar):
//   - sem usuário logado: nada aparece;
//   - Admin: tudo aparece;
//   - demais: só as telas da lista "permitidas" (pode_visualizar na tela Permissões ou, na falta,
//     a lista do perfil); lista vazia vira ['view-dashboard', 'view-meu-perfil'];
//   - Meu Perfil aparece sempre.
// O menu só ESCONDE. Quem barra o acesso de verdade é o servidor (RLS e funções), tela a tela.
(function (raiz) {
    'use strict';

    var SVG_ABRE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

    // Ordem = ordem do menu do computador. "curto" é o nome na barra do celular.
    // "subtelas": telas que não estão no menu mas pertencem a este item (acendem o item).
    var GRUPOS = [
        { id: 'sg-vendas', rotulo: 'Atendimento' },
        { id: 'sg-sistema', rotulo: 'Sistema' }
    ];
    var ITENS = [
        { id: 'leads', grupo: 'sg-vendas', view: 'view-leads', rotulo: 'Leads', curto: 'Leads',
          subtelas: ['view-jornada-lead', 'view-analise-leads'],
          icone: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>' },
        { id: 'acoes-dia', grupo: 'sg-vendas', view: 'view-acoes-dia', rotulo: 'Ações do Dia', curto: 'Ações',
          icone: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14l2 2 4-4"/>' },
        { id: 'crm', grupo: 'sg-vendas', view: 'view-crm', rotulo: 'CRM / Pipeline', curto: 'Pipeline',
          subtelas: ['view-crm-detalhe', 'view-pipelines'],
          icone: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>' },
        { id: 'agendamentos', grupo: 'sg-vendas', view: 'view-agendamentos', rotulo: 'Agendamentos', curto: 'Agenda',
          icone: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/>' },
        // WhatsApp: só Admin na prática (não entra no catálogo de telas; ic-extensoes.js, seção 9). A bolinha mostra o estado.
        { id: 'whatsapp', grupo: 'sg-sistema', view: 'view-whatsapp', rotulo: 'WhatsApp', curto: 'WhatsApp',
          extraLateral: '<span class="ic-wa-bolinha" id="ic-wa-bolinha" role="img" aria-label="Estado do WhatsApp desconhecido" hidden></span>',
          icone: '<path d="M21 11.5a8.4 8.4 0 0 1-12.6 7.3L3 21l2.3-5.2A8.5 8.5 0 1 1 21 11.5z"/>' },
        { id: 'usuarios', grupo: 'sg-sistema', view: 'view-usuarios', rotulo: 'Usuários', curto: 'Usuários',
          icone: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
        { id: 'permissoes', grupo: 'sg-sistema', view: 'view-permissoes', rotulo: 'Permissões', curto: 'Permissões',
          icone: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
        { id: 'redistribuir-leads', grupo: 'sg-sistema', view: 'view-redistribuir-leads', rotulo: 'Redistribuir Leads', curto: 'Redistribuir Leads',
          icone: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>' },
        { id: 'audit-log', grupo: 'sg-sistema', view: 'view-audit-log', rotulo: 'Histórico de Alterações', curto: 'Histórico de Alterações',
          icone: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>' },
        { id: 'meu-perfil', grupo: 'sg-sistema', view: 'view-meu-perfil', rotulo: 'Meu Perfil', curto: 'Meu Perfil',
          icone: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' }
    ];

    // As 4 primeiras posições da barra do celular, na ordem aprovada. A 5ª é sempre "Mais".
    var BARRA = ['crm', 'leads', 'acoes-dia', 'agendamentos'];

    // "Sair" não é tela: no computador fica no rodapé do menu; no celular, no fim da folha "Mais".
    var SAIR = { id: 'sair', acao: 'sair', rotulo: 'Sair', curto: 'Sair',
        icone: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>' };
    var ICONE_MAIS = '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>';
    var ICONE_FECHAR = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';

    var SEMPRE_VISIVEIS = ['view-meu-perfil', 'view-dashboard'];
    var PERMITIDAS_PADRAO = ['view-dashboard', 'view-meu-perfil'];

    function porId(id) {
        for (var i = 0; i < ITENS.length; i++) if (ITENS[i].id === id) return ITENS[i];
        return null;
    }

    // acesso: null (sem login) | { admin: true } | { admin: false, permitidas: ['view-...'] }
    function podeVerTela(viewId, acesso) {
        if (!acesso) return false;
        if (acesso.admin) return true;
        if (SEMPRE_VISIVEIS.indexOf(viewId) >= 0) return true;
        var permitidas = Array.isArray(acesso.permitidas) && acesso.permitidas.length ? acesso.permitidas : PERMITIDAS_PADRAO;
        return permitidas.indexOf(viewId) >= 0;
    }
    function podeVer(item, acesso) { return !!item && podeVerTela(item.view, acesso); }

    function itensVisiveis(acesso) {
        return ITENS.filter(function (it) { return podeVer(it, acesso); });
    }
    // Barra: só as telas fixas a que a pessoa tem acesso, na ordem aprovada. Sem acesso some (sem buraco).
    function itensBarra(acesso) {
        return BARRA.map(porId).filter(function (it) { return podeVer(it, acesso); });
    }
    // Folha "Mais": todo o resto do menu, na ordem do computador, e "Sair" no fim (só com login).
    function itensMais(acesso) {
        if (!acesso) return [];
        return itensVisiveis(acesso).filter(function (it) { return BARRA.indexOf(it.id) < 0; }).concat([SAIR]);
    }

    // Item do menu dono da tela aberta (inclui subtelas). null se a tela não pertence a nenhum.
    function itemAtivo(viewId) {
        for (var i = 0; i < ITENS.length; i++) {
            var it = ITENS[i];
            if (it.view === viewId || (it.subtelas && it.subtelas.indexOf(viewId) >= 0)) return it.id;
        }
        return null;
    }
    // "Mais" acende quando a tela aberta é uma das que estão dentro dele.
    function maisAtivo(viewId, acesso) {
        var id = itemAtivo(viewId);
        if (!id) return false;
        return itensMais(acesso).some(function (it) { return it.id === id; });
    }

    function svg(icone, tamanho) {
        var t = tamanho ? ' width="' + tamanho + '" height="' + tamanho + '"' : '';
        return SVG_ABRE + t + ' aria-hidden="true" focusable="false">' + icone + '</svg>';
    }

    // Marcação do menu lateral do computador (mesmos ids, classes e onclick de sempre: o resto do
    // sistema, como aplicarPermissoesSidebar e a marcação de item ativo do showView, procura por eles).
    function htmlLateral() {
        var h = '';
        GRUPOS.forEach(function (g, gi) {
            if (gi > 0) h += '<div class="sidebar-divider"></div>';
            h += '<div class="sidebar-section" onclick="toggleSidebarGroup(\'' + g.id + '\')">' + g.rotulo + ' <span class="section-arrow">▾</span></div>';
            h += '<div class="sidebar-group" id="' + g.id + '">';
            ITENS.forEach(function (it) {
                if (it.grupo !== g.id) return;
                h += '<button class="sidebar-item" id="nav-' + it.id + '" onclick="showView(\'' + it.view + '\')">'
                   + SVG_ABRE + '>' + it.icone + '</svg> ' + it.rotulo + (it.extraLateral ? ' ' + it.extraLateral : '') + '</button>';
            });
            h += '</div>';
        });
        return h;
    }

    var api = {
        GRUPOS: GRUPOS, ITENS: ITENS, BARRA: BARRA, SAIR: SAIR, ICONE_MAIS: ICONE_MAIS, ICONE_FECHAR: ICONE_FECHAR,
        porId: porId, podeVerTela: podeVerTela, podeVer: podeVer,
        itensVisiveis: itensVisiveis, itensBarra: itensBarra, itensMais: itensMais,
        itemAtivo: itemAtivo, maisAtivo: maisAtivo, svg: svg, htmlLateral: htmlLateral
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else raiz.IcMenu = api;
})(typeof window !== 'undefined' ? window : this);
