// IC CRM: barra de navegação do celular e do tablet (até 1023px) e a folha "Mais".
//
// Itens e regra de acesso: ic-menu.js (lista única, a mesma do menu lateral do computador).
// Carregado depois de ic-extensoes.js. O CSS está no bloco "BARRA DE NAVEGAÇÃO DO CELULAR" do tema
// (ferramentas/tema-ic.css). No computador a barra não aparece e nada daqui interfere no menu lateral.
//
// Ganchos usados pelo resto do sistema:
//   icBarraDefinirAcesso(acesso)  chamado por aplicarPermissoesSidebar e no logout; remonta a barra.
//   showView(viewId)              envolvido aqui: marca a tela aberta e fecha a folha.
(function () {
    'use strict';
    if (typeof window.IcMenu === 'undefined') { console.error('[ic-barra] ic-menu.js não carregou'); return; }
    var M = window.IcMenu;
    var LARGO = window.matchMedia('(min-width: 1024px)');
    var ID_FOLHA = 'ic-mais-folha';

    var estado = { acesso: null, view: null, aberta: false };

    function el(id) { return document.getElementById(id); }
    function escapar(t) {
        return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }

    // Tela aberta agora (a que tem .view.active dentro do conteúdo).
    function viewAtual() {
        var v = document.querySelector('.main-content .view.active');
        return v ? v.id : estado.view;
    }

    // ---------- barra ----------
    function montarBarra() {
        var lista = el('ic-barra-lista');
        if (!lista) return;
        if (!estado.acesso) { lista.innerHTML = ''; return; }
        var h = '';
        M.itensBarra(estado.acesso).forEach(function (it) {
            h += '<li><button type="button" class="ic-barra-item" data-menu-id="' + it.id + '" data-view="' + it.view + '">'
               + M.svg(it.icone, 24) + '<span class="ic-barra-rotulo">' + escapar(it.curto) + '</span></button></li>';
        });
        h += '<li><button type="button" class="ic-barra-item" id="ic-barra-mais" data-menu-id="mais" aria-haspopup="dialog"'
           + ' aria-expanded="false" aria-controls="' + ID_FOLHA + '">'
           + M.svg(M.ICONE_MAIS, 24) + '<span class="ic-barra-rotulo">Mais</span></button></li>';
        lista.innerHTML = h;
        marcarAtivo();
    }

    function marcarAtivo() {
        var view = viewAtual();
        var ativo = M.itemAtivo(view);
        var lista = el('ic-barra-lista');
        if (!lista) return;
        lista.querySelectorAll('.ic-barra-item[data-view]').forEach(function (b) {
            var sim = b.getAttribute('data-menu-id') === ativo;
            b.classList.toggle('ativo', sim);
            if (sim) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
        var mais = el('ic-barra-mais');
        if (mais) mais.classList.toggle('ativo', estado.aberta || M.maisAtivo(view, estado.acesso));
    }

    // ---------- folha "Mais" ----------
    function abrirFolha() {
        if (estado.aberta || !estado.acesso || LARGO.matches) return;
        estado.aberta = true;
        var ativo = M.itemAtivo(viewAtual());
        var h = '<div class="ic-mais-overlay" data-ic-mais="fundo"></div>'
              + '<div class="ic-mais-folha" id="' + ID_FOLHA + '" role="dialog" aria-modal="true" aria-label="Mais opções">'
              + '<div class="ic-mais-alca" aria-hidden="true"></div><ul class="ic-mais-lista">';
        M.itensMais(estado.acesso).forEach(function (it) {
            var sim = it.id === ativo;
            h += '<li><button type="button" class="ic-mais-item' + (sim ? ' ativo' : '') + '" data-menu-id="' + it.id + '"'
               + (it.view ? ' data-view="' + it.view + '"' : '') + (it.acao ? ' data-acao="' + it.acao + '"' : '')
               + (sim ? ' aria-current="page"' : '') + '>'
               + M.svg(it.icone, 24) + '<span>' + escapar(it.rotulo) + '</span></button></li>';
        });
        h += '</ul></div>';
        var raiz = document.createElement('div');
        raiz.id = 'ic-mais-raiz';
        raiz.innerHTML = h;
        document.body.appendChild(raiz);
        document.documentElement.classList.add('ic-mais-aberta');

        var mais = el('ic-barra-mais');
        if (mais) {
            mais.setAttribute('aria-expanded', 'true');
            mais.setAttribute('aria-label', 'Fechar mais opções');
            var ic = mais.querySelector('svg');
            if (ic) ic.outerHTML = M.svg(M.ICONE_FECHAR, 24);
        }
        marcarAtivo();
        var primeiro = raiz.querySelector('.ic-mais-item');
        if (primeiro) primeiro.focus();
    }

    // devolverFoco: Esc, toque no fundo e o próprio "Mais" devolvem o foco ao "Mais".
    // Escolher um item ou trocar de tela não devolve (o foco segue a tela nova).
    function fecharFolha(devolverFoco) {
        if (!estado.aberta) return;
        estado.aberta = false;
        var raiz = el('ic-mais-raiz');
        if (raiz) raiz.remove();
        document.documentElement.classList.remove('ic-mais-aberta');
        var mais = el('ic-barra-mais');
        if (mais) {
            mais.setAttribute('aria-expanded', 'false');
            mais.removeAttribute('aria-label');
            var ic = mais.querySelector('svg');
            if (ic) ic.outerHTML = M.svg(M.ICONE_MAIS, 24);
            if (devolverFoco) mais.focus();
        }
        marcarAtivo();
    }

    function escolher(btn) {
        var acao = btn.getAttribute('data-acao');
        var view = btn.getAttribute('data-view');
        fecharFolha(false);
        if (acao === 'sair') { if (typeof handleLogout === 'function') handleLogout(); return; }
        if (view && typeof showView === 'function') showView(view);
    }

    // ---------- eventos ----------
    document.addEventListener('click', function (e) {
        var alvo = e.target.closest ? e.target.closest('.ic-barra-item, .ic-mais-item, [data-ic-mais="fundo"]') : null;
        if (!alvo) return;
        if (alvo.id === 'ic-barra-mais') { estado.aberta ? fecharFolha(true) : abrirFolha(); return; }
        if (alvo.getAttribute('data-ic-mais') === 'fundo') { fecharFolha(true); return; }
        escolher(alvo);
    });

    // Esc fecha; Tab e Shift+Tab ficam dentro da folha. Fase de captura: o Esc da folha não chega
    // aos outros atalhos de Esc da tela de trás (ex.: fechar o card completo).
    document.addEventListener('keydown', function (e) {
        if (!estado.aberta) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharFolha(true); return; }
        if (e.key !== 'Tab') return;
        var itens = Array.prototype.slice.call(document.querySelectorAll('#' + ID_FOLHA + ' .ic-mais-item'));
        if (!itens.length) return;
        var primeiro = itens[0], ultimo = itens[itens.length - 1];
        var dentro = itens.indexOf(document.activeElement) >= 0;
        if (e.shiftKey && (document.activeElement === primeiro || !dentro)) { e.preventDefault(); ultimo.focus(); }
        else if (!e.shiftKey && (document.activeElement === ultimo || !dentro)) { e.preventDefault(); primeiro.focus(); }
    }, true);

    // Toque arrastado sobre o fundo escuro não rola a página de trás (iOS ignora overflow:hidden no body).
    document.addEventListener('touchmove', function (e) {
        if (estado.aberta && e.target && e.target.getAttribute && e.target.getAttribute('data-ic-mais') === 'fundo') e.preventDefault();
    }, { passive: false });

    // Botão voltar do aparelho e troca de rota sem showView: fecha.
    window.addEventListener('popstate', function () { fecharFolha(false); });
    window.addEventListener('hashchange', function () { fecharFolha(false); marcarAtivo(); });

    // Tela ficou larga (girar o tablet, janela maior): fecha.
    function aoMudarLargura() { if (LARGO.matches) fecharFolha(false); }
    if (LARGO.addEventListener) LARGO.addEventListener('change', aoMudarLargura);
    else if (LARGO.addListener) LARGO.addListener(aoMudarLargura);

    // Toda troca de tela passa por showView: marca a tela aberta e fecha a folha.
    var showViewOriginal = window.showView;
    if (typeof showViewOriginal === 'function') {
        window.showView = function (viewId) {
            var r = showViewOriginal.apply(this, arguments);
            try {
                estado.view = viewId;
                fecharFolha(false);
                marcarAtivo();
            } catch (e) { console.error('[ic-barra] showView:', e); }
            return r;
        };
    }

    window.icBarraDefinirAcesso = function (acesso) {
        fecharFolha(false);
        estado.acesso = acesso || null;
        montarBarra();
    };
    window.icBarraFecharFolha = function () { fecharFolha(false); };

    montarBarra();
})();
