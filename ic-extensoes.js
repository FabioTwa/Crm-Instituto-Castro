// IC CRM — extensões do Instituto Castro.
// Carregado DEPOIS do script principal e de encaixes-depois.js, antes do
// DOMContentLoaded (o boot roda no DOMContentLoaded).
//
// O código específico do IC CRM mora aqui, em vanilla JS, sem build. No
// index.html ficaram só ganchos (chamadas a funções ic*) e trocas de texto.
//
// Seções:
//   1. Utilitários (temperatura, telefone, origem, avatar, rótulo de perfil, erro inline)
//   2. Permissão de dinheiro e feature flags (lidas do banco)
//   3. Modal de confirmação genérico (sem confirm() nativo)
//   4. Adicionar Cliente: funil/etapa de destino + importação CSV com preview
//   5. Kanban: prévia da última mensagem, crachá da fila em alerta
//   6. Agendamentos (Parte 7): aba, modal, status, Google Agenda
//   7. Ações do Dia: handoffs da IA (Parte 6)
//   8. Roteamento: view-agendamentos e Meu Perfil (Google)
(function () {
    'use strict';

    // =====================================================================
    // 1. UTILITÁRIOS
    // =====================================================================

    // Temperatura é CALCULADA pela chave técnica da etapa (Parte 3.3), nunca
    // campo livre. Mapa único; renderCRMCard, o detalhe e o filtro usam este.
    var IC_ETAPAS_MORNAS = ['cliente_novo', 'em_conversa', 'avaliacao_inicial'];
    var IC_ETAPAS_FRIAS = ['cliente_antigo', 'perdido'];
    window.IC_ETAPAS_MORNAS = IC_ETAPAS_MORNAS;
    window.IC_ETAPAS_FRIAS = IC_ETAPAS_FRIAS;
    window.icTemperaturaEtapa = function (etapaKey) {
        var k = String(etapaKey || '');
        if (IC_ETAPAS_FRIAS.indexOf(k) >= 0) return 'frio';
        if (IC_ETAPAS_MORNAS.indexOf(k) >= 0) return 'morno';
        return 'quente';
    };

    // Etapa órfã: a chave do card não existe mais no funil carregado.
    window.icEtapaExiste = function (etapaKey) {
        if (!etapaKey) return false;
        var lista = window.CRM_ETAPAS || [];
        for (var i = 0; i < lista.length; i++) if (lista[i].key === etapaKey) return true;
        // 'perdido' e 'fechado' são estados fixos do sistema mesmo quando não são coluna
        return etapaKey === 'perdido' || etapaKey === 'fechado';
    };

    // Origem como badge (Parte 3.3): WhatsApp direto, Anúncio, Indicação, Importação manual...
    window.icRotuloOrigem = function (cl) {
        if (!cl) return 'Manual';
        if (cl.anuncio_id || cl.ctwa_token) return 'Anúncio';
        if (!String(cl.origem || '').trim()) return 'Manual';
        return icOrigemRotulo(cl.origem);   // lista oficial em ic-validacao.js
    };

    // Telefone BR formatado: (11) 99999-9999 / (11) 3333-4444. Entrada pode vir com 55.
    window.icFormatarTelefoneBR = function (tel) {
        return icTelefoneFormatar(tel);   // implementação única e testada em ic-validacao.js
    };

    // Validação de formato BR (Parte 3.6). Devolve a mensagem de erro ou null.
    // A duplicidade por funil é do banco (índice único), não daqui.
    window.icValidarTelefoneBR = function (tel) {
        var d = String(tel || '').replace(/\D/g, '');
        if (!d) return 'Telefone é obrigatório.';
        if (d.length >= 12 && d.indexOf('55') === 0) d = d.slice(2);
        if (d.length !== 10 && d.length !== 11) return 'Informe um telefone brasileiro com DDD: (11) 99999-9999.';
        var ddd = parseInt(d.slice(0, 2), 10);
        if (isNaN(ddd) || ddd < 11 || ddd > 99 || d[0] === '0') return 'DDD inválido.';
        if (d.length === 11 && d[2] !== '9') return 'Celular com 11 dígitos precisa começar com 9 depois do DDD.';
        return null;
    };

    window.icErroInline = function (id, html) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = html;
        el.style.display = 'block';
        var campo = el.previousElementSibling;
        if (campo && campo.classList) campo.style.setProperty('border-color', 'var(--ic-danger)', 'important');
    };
    window.icLimparErroInline = function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        el.style.display = 'none';
        var campo = el.previousElementSibling;
        if (campo && campo.classList) campo.style.removeProperty('border-color');
    };

    // Avatar "folha" com iniciais (Parte 2.3: raio 40px 0).
    window.icIniciais = function (nome) {
        var p = String(nome || '').trim().split(/\s+/).filter(Boolean);
        if (!p.length) return '—';
        return ((p[0][0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '')).toUpperCase();
    };
    window.icAvatarHtml = function (nome, grande) {
        if (!nome) return '';
        return '<span class="ic-avatar' + (grande ? ' ic-avatar-grande' : '') + '" title="' + (typeof escapeHtml === 'function' ? escapeHtml(nome) : nome) + '">' + icIniciais(nome) + '</span>';
    };

    // Rótulo de perfil (Parte 3.9). O nome técnico fica no banco ('Vendedor', 'SDR'); a tela mostra o rótulo da clínica. A fonte é
    // perfis_acesso.rotulo (carregado em icCarregarRotulosPerfis); se ainda não
    // carregou, vale o mapa fixo.
    var IC_ROTULOS_FIXOS = { 'Admin': 'Administrador', 'Vendedor': 'Atendente', 'SDR': 'Recepção', 'Financeiro': 'Financeiro' };
    window._icRotulosPerfil = null;
    window.icRotuloPerfil = function (nome) {
        if (!nome) return '';
        var m = window._icRotulosPerfil || {};
        return m[nome] || IC_ROTULOS_FIXOS[nome] || nome;
    };
    window.icCarregarRotulosPerfis = async function () {
        try {
            var r = await supabaseClient.from('perfis_acesso').select('nome, rotulo');
            if (r.error || !r.data) return;
            var m = {};
            r.data.forEach(function (p) { if (p.rotulo) m[p.nome] = p.rotulo; });
            window._icRotulosPerfil = m;
        } catch (e) { /* coluna rotulo pode não existir antes do 13_ic */ }
    };

    // Mensagens legíveis para os códigos de erro de ic-whatsapp-send
    var IC_ERROS_ENVIO = { envio_desligado: 'O envio pelo CRM está desligado (em configuração).', fora_da_janela_24h: 'Fora da janela de 24h da Meta: use um modelo aprovado.', card_sem_numero: 'O card não tem número de WhatsApp.', card_sem_vendedor: 'O card não tem atendente responsável.', vendedor_sem_cloud_api: 'O número do atendente não está conectado à Cloud API.', usuario_inativo: 'Seu usuário está inativo.', usuario_nao_cadastrado: 'Seu usuário não está cadastrado no CRM.', meta_recusou: 'A Meta recusou o envio. Tente novamente.', envio_nao_configurado: 'Credenciais da Meta ainda não configuradas.', texto_invalido: 'Texto inválido (1 a 4096 caracteres).' };
    window.icErroEnvioLegivel = function (codigo) { return codigo ? (IC_ERROS_ENVIO[codigo] || String(codigo)) : null; };

    // =====================================================================
    // 2. DINHEIRO E FEATURE FLAGS (fonte: banco)
    // =====================================================================
    window._icFlags = window._icFlags || {};
    window.icFlag = function (chave) { return window._icFlags[chave] === true; };
    window.icCarregarFlags = async function () {
        try {
            var r = await supabaseClient.from('ic_feature_flags').select('chave, ligada');
            if (r.error || !r.data) return;
            var f = {};
            r.data.forEach(function (x) { f[x.chave] = x.ligada === true; });
            window._icFlags = f;
        } catch (e) { console.warn('[ic] flags indisponíveis:', e && e.message); }
        if (typeof icCarregarRotulosPerfis === 'function') await icCarregarRotulosPerfis();
    };

    // =====================================================================
    // 3. MODAL DE CONFIRMAÇÃO GENÉRICO (Parte 3.2)
    // =====================================================================
    // Usa o #modal-confirm; nunca confirm() nativo. destrutivo=true pinta o
    // botão de confirmar com o estilo destrutivo. A mensagem é TEXTO (textContent):
    // nome de lead vem do WhatsApp e nunca pode ser interpretado como HTML.
    window.icConfirmar = function (mensagem, rotuloConfirmar, onConfirmar, destrutivo) {
        var msg = document.getElementById('confirm-message');
        var btn = document.getElementById('confirm-btn');
        var titulo = document.querySelector('#modal-confirm .modal-header h2');
        if (titulo) titulo.textContent = 'Confirmar ação';
        if (!msg || !btn) { if (window.confirm(String(mensagem))) onConfirmar(); return; }
        msg.textContent = mensagem;
        msg.style.whiteSpace = 'pre-line';
        btn.textContent = rotuloConfirmar || 'Confirmar';
        btn.className = destrutivo ? 'btn ic-destrutivo' : 'btn btn-primary ic-folha';
        btn.onclick = function () { closeModal('modal-confirm'); try { onConfirmar(); } catch (e) { console.error(e); } };
        openModal('modal-confirm');
    };

    // Pergunta com campo de texto (substitui prompt() nativo). Modal próprio, filho direto do body.
    // onOk recebe o texto digitado (pode ser vazio se obrigatorio for false).
    window.icPerguntar = function (titulo, rotuloCampo, placeholder, rotuloOk, onOk, obrigatorio) {
        var id = 'modal-ic-pergunta';
        var m = document.getElementById(id);
        if (m) m.remove();
        m = document.createElement('div');
        m.className = 'modal-overlay';
        m.id = id;
        m.innerHTML = '<div class="modal-card" style="max-width:460px">'
            + '<div class="modal-header"><h2></h2><button type="button" class="modal-close" aria-label="Fechar">&times;</button></div>'
            + '<div class="form-group"><label></label><textarea class="form-textarea" rows="3" maxlength="500"></textarea>'
            + '<div class="ic-erro-inline" style="display:none;color:var(--ic-danger);font-size:12px;margin-top:4px"></div></div>'
            + '<div class="modal-footer"><button type="button" class="btn btn-secondary" data-ic="cancelar">Cancelar</button>'
            + '<button type="button" class="btn ic-destrutivo" data-ic="ok"></button></div></div>';
        document.body.appendChild(m);
        m.querySelector('h2').textContent = titulo;
        m.querySelector('label').textContent = rotuloCampo;
        var ta = m.querySelector('textarea'); ta.placeholder = placeholder || '';
        m.querySelector('[data-ic="ok"]').textContent = rotuloOk || 'Confirmar';
        var fechar = function () { m.classList.remove('active'); setTimeout(function () { m.remove(); }, 200); };
        m.querySelector('.modal-close').onclick = fechar;
        m.querySelector('[data-ic="cancelar"]').onclick = fechar;
        m.onclick = function (e) { if (e.target === m) fechar(); };
        m.querySelector('[data-ic="ok"]').onclick = function () {
            var v = ta.value.trim();
            if (obrigatorio && !v) { var er = m.querySelector('.ic-erro-inline'); er.textContent = 'Preencha este campo.'; er.style.display = 'block'; return; }
            fechar();
            try { onOk(v); } catch (e) { console.error(e); }
        };
        requestAnimationFrame(function () { m.classList.add('active'); ta.focus(); });
    };

    // Aviso com um único botão (substitui alert() nativo). Texto puro, com quebras de linha.
    window.icAviso = function (titulo, texto) {
        var id = 'modal-ic-aviso';
        var m = document.getElementById(id); if (m) m.remove();
        m = document.createElement('div'); m.className = 'modal-overlay'; m.id = id;
        m.innerHTML = '<div class="modal-card" style="max-width:480px"><div class="modal-header"><h2></h2><button type="button" class="modal-close" aria-label="Fechar">&times;</button></div>'
            + '<p style="font-size:14px;line-height:1.6;color:var(--ic-text);white-space:pre-line;margin-bottom:8px"></p>'
            + '<div class="modal-footer"><button type="button" class="btn btn-primary ic-folha">Entendi</button></div></div>';
        document.body.appendChild(m);
        m.querySelector('h2').textContent = titulo;
        m.querySelector('p').textContent = texto;
        var fechar = function () { m.classList.remove('active'); setTimeout(function () { m.remove(); }, 200); };
        m.querySelector('.modal-close').onclick = fechar;
        m.querySelector('.btn').onclick = fechar;
        m.onclick = function (e) { if (e.target === m) fechar(); };
        requestAnimationFrame(function () { m.classList.add('active'); });
    };

    // Modais estáticos do HTML moram dentro de <main>. Dentro de um container com stacking
    // context próprio eles ficariam presos abaixo do painel lateral. Sobem para o <body>,
    // onde a escala --z-* vale para todos. Os criados por JS já nascem no body.
    window.icModaisParaBody = function () {
        document.querySelectorAll('.modal-overlay').forEach(function (m) {
            if (m.parentElement !== document.body) document.body.appendChild(m);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', icModaisParaBody); else icModaisParaBody();

    // =====================================================================
    // 4. ADICIONAR CLIENTE: funil/etapa + CSV com preview
    // =====================================================================
    window.icPopularFunisSelect = async function (selectId, funilPadrao, etapaSelectId) {
        var sel = document.getElementById(selectId);
        if (!sel) return;
        var funis = window.crmPipelines && window.crmPipelines.length ? window.crmPipelines : null;
        if (!funis) {
            var r = await supabaseClient.from('crm_funis').select('id, nome, ordem').eq('ativo', true).order('ordem');
            funis = r.data || [];
        }
        sel.innerHTML = funis.map(function (f) {
            return '<option value="' + f.id + '"' + (f.id === funilPadrao ? ' selected' : '') + '>' + escapeHtml(f.nome) + '</option>';
        }).join('');
        if (etapaSelectId) await icPopularEtapasDoFunil(sel.value, etapaSelectId);
    };
    window.icPopularEtapasDoFunil = async function (funilId, etapaSelectId) {
        var sel = document.getElementById(etapaSelectId);
        if (!sel || !funilId) return;
        var r = await supabaseClient.from('crm_funil_etapas').select('nome, label, ordem').eq('funil_id', funilId).order('ordem');
        var etapas = (r.data || []).filter(function (e) { return e.nome !== 'fechado'; });
        sel.innerHTML = etapas.map(function (e, i) {
            return '<option value="' + escapeHtml(e.nome) + '"' + (i === 0 ? ' selected' : '') + '>' + escapeHtml(e.label || e.nome) + '</option>';
        }).join('');
    };

    // Importação CSV: abre a caixa de importação e acrescenta um preview de mapeamento
    // de colunas (Parte 3.6) antes do botão Importar.
    window.icAbrirImportacaoCSV = function () {
        var box = document.getElementById('crm-import-box');
        if (!box) return;
        box.style.display = 'block';
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var inp = document.getElementById('crm-csv-file');
        if (inp && !inp._icPreview) {
            inp._icPreview = true;
            inp.addEventListener('change', function () { icPreviewCSV(inp.files && inp.files[0]); });
        }
    };
    var IC_CSV_CAMPOS = {
        nome: ['nome', 'name', 'cliente', 'paciente', 'lead'],
        telefone: ['telefone', 'phone', 'celular', 'whatsapp', 'fone', 'tel'],
        email: ['email', 'e-mail', 'mail'],
        cpf: ['cpf', 'documento'],
        profissao: ['profissao', 'profissão', 'ocupacao', 'ocupação'],
        origem: ['origem', 'fonte', 'source', 'canal'],
        observacoes: ['observacoes', 'observações', 'obs', 'notas', 'comentario']
    };
    function icNormalizarCab(s) { return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
    window.icPreviewCSV = function (file) {
        var alvo = document.getElementById('ic-csv-preview');
        if (!alvo) return;
        if (!file) { alvo.innerHTML = ''; return; }
        var reader = new FileReader();
        reader.onload = function (ev) {
            var linhas = String(ev.target.result || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
            if (!linhas.length) { alvo.innerHTML = '<div class="leads-vazio">Arquivo vazio.</div>'; return; }
            var sep = linhas[0].indexOf(';') >= 0 && linhas[0].indexOf(',') < 0 ? ';' : ',';
            var cab = linhas[0].split(sep).map(function (c) { return c.replace(/^"|"$/g, '').trim(); });
            var h = '<div class="ic-aviso-discreto" style="display:block;margin:10px 0">' + (linhas.length - 1) + ' linha' + (linhas.length - 1 === 1 ? '' : 's') + ' detectada' + (linhas.length - 1 === 1 ? '' : 's') + ' · separador "' + sep + '"</div>';
            h += '<div class="ic-eyebrow" style="margin:10px 0 6px">Mapeamento de colunas</div>';
            h += '<table class="fin-table" style="width:100%"><thead><tr><th>Coluna do arquivo</th><th>Campo do CRM</th><th>Exemplo (1ª linha)</th></tr></thead><tbody>';
            var ex = linhas.length > 1 ? linhas[1].split(sep) : [];
            cab.forEach(function (c, i) {
                var n = icNormalizarCab(c), campo = '—';
                Object.keys(IC_CSV_CAMPOS).forEach(function (k) { if (campo === '—' && IC_CSV_CAMPOS[k].indexOf(n) >= 0) campo = k; });
                h += '<tr><td>' + escapeHtml(c) + '</td><td>' + (campo === '—' ? '<span class="ic-badge ic-badge-neutro">ignorada</span>' : '<span class="ic-badge ic-badge-ok">' + campo + '</span>') + '</td><td class="ic-meta">' + escapeHtml((ex[i] || '').replace(/^"|"$/g, '').slice(0, 40)) + '</td></tr>';
            });
            h += '</tbody></table>';
            var temTel = cab.some(function (c) { return IC_CSV_CAMPOS.telefone.indexOf(icNormalizarCab(c)) >= 0; });
            if (!temTel) h += '<div class="leads-vazio" style="margin-top:8px;color:var(--ic-danger)">Nenhuma coluna de telefone reconhecida. Renomeie o cabeçalho para "telefone" antes de importar.</div>';
            alvo.innerHTML = h;
        };
        reader.readAsText(file, 'UTF-8');
    };

    // =====================================================================
    // 5. KANBAN: prévia da última mensagem + crachá em alerta
    // =====================================================================
    // Depois que o Kanban desenha, busca a última mensagem de cada card visível
    // (RPC ic_ultimas_mensagens, 20_ic_apoio_front.sql) e injeta a prévia.
    // Se a RPC não existir, não faz nada: o card continua sem a prévia.
    window.icCarregarPreviasCards = async function () {
        var cards = Array.prototype.slice.call(document.querySelectorAll('.crm-card-pro[data-id]:not([data-ic-previa])'));
        if (!cards.length) return;
        var ids = cards.map(function (c) { return c.getAttribute('data-id'); }).slice(0, 400);
        var r;
        try { r = await supabaseClient.rpc('ic_ultimas_mensagens', { p_ids: ids }); } catch (e) { return; }
        if (!r || r.error || !r.data) return;
        var mapa = {};
        r.data.forEach(function (m) { mapa[m.cliente_crm_id] = m; });
        cards.forEach(function (c) {
            c.setAttribute('data-ic-previa', '1');
            var m = mapa[c.getAttribute('data-id')];
            if (!m || !m.exibicao) return;
            if (c.querySelector('.ic-card-previa')) return;
            var el = document.createElement('div');
            el.className = 'ic-card-previa';
            el.textContent = String(m.exibicao).slice(0, 140);
            var badges = c.querySelector('.ic-card-badges');
            if (badges && badges.parentNode) badges.parentNode.insertBefore(el, badges.nextSibling);
        });
    };
    // Observa o container do pipeline: toda vez que colunas/cards entram, carrega prévias
    // e checa o crachá. Debounce para não disparar a cada card do scroll infinito.
    var _icPreviaTimer = null;
    function icAgendarPrevias() {
        clearTimeout(_icPreviaTimer);
        _icPreviaTimer = setTimeout(function () { icCarregarPreviasCards(); icChecarCracha(); }, 350);
    }
    // Crachá da fila (Parte 3.13): fica em alerta quando "aguardando" cresce.
    var IC_FILA_ALERTA = 10;
    window.icChecarCracha = function () {
        var el = document.getElementById('crm-fila-espera');
        if (!el) return;
        var m = (el.textContent || '').match(/(\d+)/);
        var n = m ? parseInt(m[1], 10) : 0;
        el.classList.toggle('ic-alerta', n >= IC_FILA_ALERTA);
    };
    function icLigarObservadorKanban() {
        var alvo = document.getElementById('crm-pipeline-content');
        if (!alvo || alvo._icObs) return;
        alvo._icObs = new MutationObserver(icAgendarPrevias);
        alvo._icObs.observe(alvo, { childList: true, subtree: true });
        var cracha = document.body;
        if (cracha && !cracha._icObsCracha) {
            cracha._icObsCracha = new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var t = muts[i].target;
                    if (t && t.id === 'crm-fila-espera' || (t && t.closest && t.closest('#crm-fila-espera'))) { icChecarCracha(); return; }
                }
            });
            cracha._icObsCracha.observe(cracha, { childList: true, subtree: true, characterData: true });
        }
    }

    // =====================================================================
    // 6. AGENDAMENTOS (Parte 7)
    // =====================================================================
    var IC_STATUS_AG = { pendente: 'Pendente', confirmado: 'Confirmado', cancelado: 'Cancelado', realizado: 'Realizado', faltou: 'Faltou' };
    window._icAgFiltros = window._icAgFiltros || {};

    function icHojeISO(deslocDias) {
        var d = new Date(); d.setDate(d.getDate() + (deslocDias || 0));
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function icDataBR(iso) { try { return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }); } catch (e) { return iso; } }
    function icHoraBR(iso) { try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

    window.icLoadAgendamentos = async function () {
        if (typeof checarAcessoTela === 'function' && !checarAcessoTela('view-agendamentos')) return;
        var c = document.getElementById('agendamentos-content');
        if (!c) return;
        c.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div></div>';
        var f = window._icAgFiltros;
        if (!f.de) f.de = icHojeISO(0);
        if (!f.ate) f.ate = icHojeISO(14);
        var ehAdmin = window._perfilAtualCache && window._perfilAtualCache.is_admin;
        var r = await supabaseClient.rpc('ic_agendamentos_lista', { p_de: f.de, p_ate: f.ate, p_responsavel: f.responsavel || null, p_status: f.status || null });
        var h = '<div class="page-header"><h1>Agendamentos</h1><div class="header-actions">'
              + '<button class="btn btn-secondary" onclick="icSincronizarPendentes()" title="Reenvia ao Google Agenda os agendamentos que ainda não sincronizaram">' + icon('refresh-cw', 14) + ' Sincronizar</button>'
              + '</div></div>';
        h += '<div class="ic-toolbar" role="toolbar" aria-label="Filtros de Agendamentos">';
        h += '<div class="ic-tb-item ic-tb-data"><span class="ic-tb-prefixo">De</span><input type="date" aria-label="Data inicial" value="' + f.de + '" onchange="window._icAgFiltros.de=this.value;icLoadAgendamentos()"></div>';
        h += '<div class="ic-tb-item ic-tb-data"><span class="ic-tb-prefixo">Até</span><input type="date" aria-label="Data final" value="' + f.ate + '" onchange="window._icAgFiltros.ate=this.value;icLoadAgendamentos()"></div>';
        h += '<div class="ic-tb-item ic-tb-periodo"><select aria-label="Status" onchange="window._icAgFiltros.status=this.value;icLoadAgendamentos()"><option value="">Todos os status</option>'
           + Object.keys(IC_STATUS_AG).map(function (k) { return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + IC_STATUS_AG[k] + '</option>'; }).join('') + '</select></div>';
        if (ehAdmin) {
            h += '<div class="ic-tb-item ic-tb-resp"><select id="ic-ag-filtro-resp" aria-label="Responsável" onchange="window._icAgFiltros.responsavel=this.value;icLoadAgendamentos()"><option value="">Todos os responsáveis</option></select></div>';
        }
        h += '</div>';
        if (r.error) {
            h += '<div class="leads-vazio">Não foi possível carregar a agenda: ' + escapeHtml(r.error.message) + '. Confira se o arquivo 18_ic_agendamentos.sql foi executado.</div>';
            c.innerHTML = h; return;
        }
        var itens = r.data || [];
        if (!itens.length) {
            h += '<div class="ic-vazio-grande">' + icon('calendar', 36) + '<h3>Nenhum agendamento no período</h3><p>Agende a partir do card do lead (botão "Agendar") ou aguarde as propostas da assistente virtual.</p></div>';
        } else {
            var porDia = {};
            itens.forEach(function (a) { var k = String(a.inicio).slice(0, 10); (porDia[k] = porDia[k] || []).push(a); });
            Object.keys(porDia).sort().forEach(function (dia) {
                h += '<div class="ic-agenda-dia"><h3>' + escapeHtml(icDataBR(dia + 'T12:00:00')) + '</h3>';
                porDia[dia].forEach(function (a) { h += icAgendaItemHtml(a); });
                h += '</div>';
            });
        }
        c.innerHTML = h;
        if (ehAdmin) icPopularResponsaveis('ic-ag-filtro-resp', f.responsavel, true);
        if (window.lucide && lucide.createIcons) { try { lucide.createIcons(); } catch (e) {} }
    };

    function icAgendaItemHtml(a) {
        var st = a.status || 'pendente';
        var h = '<div class="ic-agenda-item" data-id="' + a.id + '">';
        h += '<div><div class="ic-agenda-hora">' + icHoraBR(a.inicio) + '</div><div class="ic-agenda-sub">' + icHoraBR(a.fim) + '</div></div>';
        h += '<div><div class="ic-agenda-nome"><a href="#" onclick="openCRMDetalhe(\'' + a.cliente_crm_id + '\');return false;" style="color:inherit">' + escapeHtml(a.nome || 'Lead') + '</a>'
           + ' <span class="ic-badge ic-status-' + st + '">' + (IC_STATUS_AG[st] || st) + '</span>'
           + (a.origem === 'ia' ? ' <span class="ic-badge ic-badge-ia" title="Proposto pela assistente virtual; confirmação é humana">Proposto pela IA</span>' : '') + '</div>';
        h += '<div class="ic-agenda-sub">' + escapeHtml(a.titulo || '') + ' · ' + escapeHtml(icFormatarTelefoneBR(a.telefone || '')) + ' · ' + escapeHtml(a.responsavel_nome || 'Sem responsável')
           + (a.funil_nome ? ' · ' + escapeHtml(a.funil_nome) : '') + (a.etapa_label ? ' / ' + escapeHtml(a.etapa_label) : '') + '</div>';
        h += '<div class="ic-agenda-sub">' + icSyncBadge(a) + (a.observacoes ? ' · ' + escapeHtml(String(a.observacoes).slice(0, 80)) : '') + '</div></div>';
        h += '<div class="ic-agenda-acoes">';
        if (st === 'pendente') h += '<button class="btn btn-sm btn-primary" onclick="icAgendamentoStatus(\'' + a.id + '\',\'confirmado\')">Confirmar</button>';
        if (st === 'confirmado') {
            h += '<button class="btn btn-sm btn-primary" onclick="icAgendamentoStatus(\'' + a.id + '\',\'realizado\')">Realizado</button>';
            h += '<button class="btn btn-sm btn-secondary" onclick="icAgendamentoStatus(\'' + a.id + '\',\'faltou\')">Faltou</button>';
        }
        if (st === 'pendente' || st === 'confirmado') h += '<button class="btn btn-sm ic-destrutivo" onclick="icAgendamentoStatus(\'' + a.id + '\',\'cancelado\')">Cancelar</button>';
        h += '</div></div>';
        return h;
    }
    function icSyncBadge(a) {
        var s = a.google_sync_status || 'pendente';
        if (s === 'sincronizado') return '<span class="ic-badge ic-badge-ok" title="Evento criado na Google Agenda do responsável">Google Agenda ✓</span>';
        if (s === 'erro') return '<span class="ic-badge ic-badge-alerta" title="' + escapeHtml(a.google_sync_erro || '') + '">Erro na sincronização</span>';
        if (s === 'desligado') return '<span class="ic-badge ic-badge-neutro" title="Integração com Google Agenda desligada ou responsável sem conta conectada">Sem Google Agenda</span>';
        return '<span class="ic-badge ic-badge-neutro">Sincronização pendente</span>';
    }

    window.icPopularResponsaveis = async function (selectId, selecionado, incluirTodos) {
        var sel = document.getElementById(selectId);
        if (!sel) return;
        var r = await supabaseClient.from('users').select('id, name, email, perfil').in('perfil', ['Vendedor', 'SDR', 'Admin']).eq('status', 'ativo').order('name');
        var h = incluirTodos ? '<option value="">Todos os responsáveis</option>' : '<option value="">Selecione...</option>';
        (r.data || []).forEach(function (u) { h += '<option value="' + u.id + '"' + (u.id === selecionado ? ' selected' : '') + '>' + escapeHtml(u.name || u.email) + '</option>'; });
        sel.innerHTML = h;
    };

    window.icAbrirModalAgendamento = async function (clienteId, nome) {
        var form = document.getElementById('form-agendamento');
        if (!form) return;
        form.reset();
        document.getElementById('ag-cliente-id').value = clienteId;
        document.getElementById('ag-cliente-nome').value = nome || '';
        form.elements['data'].value = icHojeISO(1);
        form.elements['hora'].value = '09:00';
        var respPadrao = null;
        try {
            var rc = await supabaseClient.from('clientes_crm').select('vendedor_id').eq('id', clienteId).maybeSingle();
            respPadrao = rc.data ? rc.data.vendedor_id : null;
        } catch (e) {}
        await icPopularResponsaveis('ag-responsavel', respPadrao, false);
        openModal('modal-agendamento');
    };

    // Chama a Edge Function ic-agendamento (que grava via RPC e sincroniza com o
    // Google). Se a função não estiver publicada, cai na RPC direta: o agendamento
    // nasce no CRM com google_sync_status 'pendente' e sincroniza depois.
    async function icChamarAgendamento(body) {
        try {
            var resp = await supabaseClient.functions.invoke('ic-agendamento', { body: body });
            if (resp.error) throw resp.error;
            return { ok: true, data: resp.data, viaEdge: true };
        } catch (e) {
            return { ok: false, erro: e };
        }
    }

    window.icSalvarAgendamento = async function (ev) {
        ev.preventDefault();
        var form = ev.target, btn = document.getElementById('btn-salvar-agendamento');
        if (typeof setBtnLoading === 'function') setBtnLoading(btn, true);
        try {
            var cliente = form.elements['cliente_crm_id'].value;
            var inicio = new Date(form.elements['data'].value + 'T' + form.elements['hora'].value + ':00');
            if (isNaN(inicio.getTime())) throw new Error('Data ou horário inválidos.');
            if (inicio < new Date()) throw new Error('O agendamento precisa ser no futuro.');
            var dur = parseInt(form.elements['duracao'].value, 10) || 30;
            var fim = new Date(inicio.getTime() + dur * 60000);
            var tipo = form.elements['tipo'].value;
            var titulo = ({ consulta: 'Consulta / avaliação', retorno: 'Retorno', exame: 'Exame', visita: 'Visita à clínica' })[tipo] || 'Consulta';
            var body = { acao: 'criar', cliente_crm_id: cliente, inicio: inicio.toISOString(), fim: fim.toISOString(), responsavel_id: form.elements['responsavel_id'].value, titulo: titulo, tipo: tipo, observacoes: (form.elements['observacoes'].value || '').trim() || null };
            var r = await icChamarAgendamento(body);
            if (!r.ok) {
                var rpc = await supabaseClient.rpc('ic_agendamento_criar', { p_cliente: cliente, p_inicio: body.inicio, p_fim: body.fim, p_responsavel: body.responsavel_id, p_titulo: titulo, p_tipo: tipo, p_obs: body.observacoes });
                if (rpc.error) throw rpc.error;
                showToast('Agendamento salvo no CRM. A sincronização com o Google Agenda fica pendente até a integração ser publicada.', 'info');
            } else {
                showToast('Agendamento salvo.', 'success');
            }
            closeModal('modal-agendamento');
            if (typeof crmRefrescarDetalhe === 'function' && crmCurrentClienteId === cliente) crmRefrescarDetalhe(cliente, true);
            if (document.getElementById('view-agendamentos') && document.getElementById('view-agendamentos').classList.contains('active')) icLoadAgendamentos();
        } catch (e) {
            showToast('Não foi possível agendar: ' + (e.message || e), 'error');
        } finally {
            if (typeof setBtnLoading === 'function') setBtnLoading(btn, false);
        }
    };

    window.icAgendamentoStatus = function (id, status) {
        var textos = { confirmado: 'Confirmar este agendamento? O card avança para a etapa de agendamento e o atendimento passa para a equipe (handoff).', cancelado: 'Cancelar este agendamento?', realizado: 'Marcar como realizado?', faltou: 'Marcar que o lead faltou?' };
        icConfirmar(textos[status] || 'Confirmar?', IC_STATUS_AG[status] || 'Confirmar', async function () {
            var r = await icChamarAgendamento({ acao: 'status', id: id, status: status });
            if (!r.ok) {
                var rpc = await supabaseClient.rpc('ic_agendamento_status', { p_id: id, p_status: status });
                if (rpc.error) { showToast('Não foi possível atualizar: ' + rpc.error.message, 'error'); return; }
            }
            showToast('Agendamento ' + (IC_STATUS_AG[status] || status).toLowerCase() + '.', 'success');
            icLoadAgendamentos();
        }, status === 'cancelado');
    };

    window.icSincronizarPendentes = async function () {
        var r = await icChamarAgendamento({ acao: 'sincronizar_pendentes' });
        if (!r.ok) { showToast('A função de agendamento ainda não está publicada. Nada foi sincronizado.', 'warning'); return; }
        showToast('Sincronização solicitada.', 'success');
        icLoadAgendamentos();
    };

    // Meu Perfil: conectar a Google Agenda do usuário (OAuth pela Edge Function).
    window.icMeuPerfilGoogle = async function () {
        var cont = document.querySelector('#view-meu-perfil .perfil-container');
        if (!cont || document.getElementById('ic-google-card')) return;
        var card = document.createElement('div');
        card.className = 'perfil-card';
        card.id = 'ic-google-card';
        card.innerHTML = '<h3>Google Agenda</h3><p class="ic-meta" style="margin-bottom:12px">Os agendamentos dos seus leads entram na sua agenda com o telefone do lead na descrição. Nada clínico é enviado ao Google.</p><div id="ic-google-status" class="ic-meta">Verificando...</div><button class="btn btn-secondary" style="margin-top:12px" onclick="icConectarGoogle()" id="ic-google-btn">Conectar Google Agenda</button>';
        cont.appendChild(card);
        var st = document.getElementById('ic-google-status');
        try {
            var r = await supabaseClient.rpc('ic_minha_agenda_google');
            if (!r.error && r.data && (r.data.ativo || (r.data[0] && r.data[0].ativo))) {
                var d = r.data[0] || r.data;
                st.innerHTML = '<span class="ic-badge ic-badge-ok">Conectada</span> ' + escapeHtml(d.google_email || '');
                document.getElementById('ic-google-btn').textContent = 'Reconectar';
            } else {
                st.innerHTML = '<span class="ic-badge ic-badge-neutro">Não conectada</span>';
            }
        } catch (e) { st.textContent = 'Integração ainda não publicada.'; }
    };
    window.icConectarGoogle = async function () {
        if (!icFlag('agendamento_google')) { showToast('A integração com o Google Agenda está desligada (flag agendamento_google).', 'warning'); return; }
        var r = await icChamarAgendamento({ acao: 'google_oauth_url' });
        if (!r.ok || !r.data || !r.data.url) { showToast('Não foi possível iniciar a conexão com o Google.', 'error'); return; }
        window.open(r.data.url, '_blank', 'noopener');
    };

    // =====================================================================
    // 7. AÇÕES DO DIA: handoffs da IA
    // =====================================================================
    var IC_MOTIVO_HANDOFF = { duvida_clinica: 'Dúvida clínica', urgencia: 'Urgência', reclamacao: 'Reclamação', pedido_humano: 'Pediu um humano', agendamento_confirmado: 'Agendamento confirmado', consentimento_negado: 'Não consentiu com a IA', erro_ia: 'Resposta da IA bloqueada', manual: 'Encaminhamento manual' };
    window.icRenderHandoffs = async function () {
        var c = document.getElementById('acoes-dia-content');
        if (!c || document.getElementById('ic-handoffs')) return;
        var r;
        try { r = await supabaseClient.rpc('ic_handoffs_pendentes'); } catch (e) { return; }
        if (!r || r.error || !r.data || !r.data.length) return;
        var bloco = document.createElement('div');
        bloco.id = 'ic-handoffs';
        bloco.style.marginBottom = '20px';
        var h = '<div class="ic-eyebrow" style="margin-bottom:8px">Encaminhados pela assistente virtual · ' + r.data.length + '</div><div class="acao-lista">';
        r.data.forEach(function (x) {
            h += '<div class="acao-linha ic-handoff"><div class="acao-corpo"><div class="acao-cab"><strong class="acao-nome" onclick="openCRMDetalhe(\'' + x.cliente_crm_id + '\')">' + escapeHtml(x.nome || 'Lead') + '</strong> <span class="ic-handoff-motivo">' + (IC_MOTIVO_HANDOFF[x.motivo] || x.motivo) + '</span></div>'
               + '<div class="acao-porque">' + escapeHtml(x.detalhe || 'A assistente parou de responder e passou o atendimento para a equipe.') + ' · ' + escapeHtml(icFormatarTelefoneBR(x.telefone || '')) + '</div>'
               + '<div class="acao-rodape">' + (typeof crmFormatarTempoDecorrido === 'function' ? 'há ' + crmFormatarTempoDecorrido(Date.now() - new Date(x.criado_em).getTime()) : '') + '</div></div>'
               + '<div class="ic-agenda-acoes"><button class="btn btn-sm btn-primary" onclick="icHandoffAtender(\'' + x.id + '\',\'' + x.cliente_crm_id + '\')">Assumir</button></div></div>';
        });
        h += '</div>';
        bloco.innerHTML = h;
        var header = c.querySelector('.fin-header');
        if (header && header.nextSibling) c.insertBefore(bloco, header.nextSibling.nextSibling || null); else c.insertBefore(bloco, c.firstChild);
    };
    window.icHandoffAtender = async function (id, clienteId) {
        var r = await supabaseClient.rpc('ic_handoff_atender', { p_id: id });
        if (r.error) { showToast('Não foi possível assumir: ' + r.error.message, 'error'); return; }
        showToast('Atendimento assumido.', 'success');
        if (clienteId && typeof openCRMDetalhe === 'function') openCRMDetalhe(clienteId);
    };

    // =====================================================================
    // 8. ROTEAMENTO: envolve showView e os loaders sem editá-los
    // =====================================================================
    function envolver(nome, depois) {
        var orig = window[nome];
        if (typeof orig !== 'function') return;
        window[nome] = function () {
            var r = orig.apply(this, arguments);
            try { depois.apply(this, arguments); } catch (e) { console.error('[ic] gancho ' + nome + ':', e); }
            return r;
        };
    }
    envolver('showView', function (viewId) {
        var nav = document.getElementById('nav-agendamentos');
        if (nav) nav.classList.toggle('active', viewId === 'view-agendamentos');
        if (viewId === 'view-agendamentos') icLoadAgendamentos();
        if (viewId === 'view-crm') setTimeout(icLigarObservadorKanban, 0);
        if (viewId === 'view-meu-perfil') setTimeout(icMeuPerfilGoogle, 300);
    });
    envolver('loadAcoesDia', function () { setTimeout(icRenderHandoffs, 600); });
    envolver('loadCRM', function () { setTimeout(icLigarObservadorKanban, 0); });

    // =====================================================================
    // 9. ROTA DO CARD COMPLETO: #/card/<id> (Parte 3.4)
    // =====================================================================
    // Recarregar a página ou compartilhar o link reabre o mesmo card. O "voltar" do navegador
    // devolve ao Kanban no mesmo funil e na mesma posição de rolagem. O link antigo
    // #card=<id> (descrição do evento do Google Agenda) continua valendo e é normalizado.
    var ROTA_CARD = '#/card/';
    var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Devolve null (não é rota de card), '' (rota de card com id inválido) ou o id.
    function icIdDaRota() {
        var h = location.hash || '';
        var bruto = null;
        if (h.indexOf(ROTA_CARD) === 0) bruto = h.slice(ROTA_CARD.length).split('?')[0];
        else if (h.indexOf('#card=') === 0) bruto = h.slice(6).split('&')[0];
        if (bruto === null) return null;
        return UUID.test(bruto) ? bruto : '';
    }
    window.icCardNaoEncontradoHtml = function () {
        return '<div class="ic-vazio-grande" style="margin-top:24px">' + (typeof icon === 'function' ? icon('search-x', 36) : '')
            + '<h3>Card não encontrado</h3>'
            + '<p>O card não existe, foi excluído ou você não tem permissão para vê-lo.</p>'
            + '<p style="margin-top:14px"><button type="button" class="btn btn-primary" onclick="icVoltarAoPipeline()">← Voltar ao Pipeline</button></p></div>';
    };

    // Estado do Kanban guardado ao abrir um card e devolvido ao voltar.
    function icSalvarEstadoKanban() {
        var board = document.querySelector('.crm-board, #crm-board');
        var est = { funil: window.crmCurrentPipelineId || null, scrollY: window.scrollY || 0, boardLeft: board ? board.scrollLeft : 0, colunas: [] };
        document.querySelectorAll('.crm-col-body').forEach(function (el) { est.colunas.push(el.scrollTop); });
        window._icKanbanEstado = est;
        try { sessionStorage.setItem('ic_kanban_estado', JSON.stringify(est)); } catch (e) {}
    }
    function icLerEstadoKanban() {
        if (window._icKanbanEstado) return window._icKanbanEstado;
        try { return JSON.parse(sessionStorage.getItem('ic_kanban_estado') || 'null'); } catch (e) { return null; }
    }
    function icRestaurarRolagemKanban() {
        var est = icLerEstadoKanban();
        if (!est) return;
        var tentativas = 0;
        (function tentar() {
            // o Kanban recarrega do banco: espera os cards existirem antes de rolar
            if (!document.querySelector('.crm-card-pro') && tentativas++ < 40) return setTimeout(tentar, 200);
            window.scrollTo(0, est.scrollY || 0);
            document.querySelectorAll('.crm-col-body').forEach(function (el, i) { if (est.colunas && est.colunas[i]) el.scrollTop = est.colunas[i]; });
            var board = document.querySelector('.crm-board, #crm-board');
            if (board && est.boardLeft) board.scrollLeft = est.boardLeft;
            window._icKanbanEstado = null;   // uso único: navegar ao Kanban pelo menu depois não rola para a posição antiga
        })();
    }
    // Antes de montar o Kanban, devolve o funil que estava aberto (sobrevive a F5 no card).
    (function () {
        var origLoadCRM = window.loadCRM;
        if (typeof origLoadCRM !== 'function') return;
        window.loadCRM = function () {
            var est = icLerEstadoKanban();
            if (!window.crmCurrentPipelineId && est && est.funil) window.crmCurrentPipelineId = est.funil;
            return origLoadCRM.apply(this, arguments);
        };
    })();

    var abrirCardBase = window.openCRMDetalhe;
    // Abre o card sem criar entrada nova no histórico (usado quando a URL já é a do card).
    function icAbrirSemEmpilhar(id) { return abrirCardBase(id); }
    window.openCRMDetalhe = function (id) {
        // guarda: clique logo depois de um arrasto não abre card
        if (window._crmLastDragTime && (Date.now() - window._crmLastDragTime) < 300) return;
        var rota = ROTA_CARD + id;
        if (location.hash !== rota) {
            var vemDoKanban = document.getElementById('view-crm') && document.getElementById('view-crm').classList.contains('active');
            if (vemDoKanban) icSalvarEstadoKanban();
            // Se a gaveta do card está aberta, a entrada de histórico dela é SUBSTITUÍDA pela do card:
            // empilhar uma terceira faria o "voltar" cair numa entrada fantasma e reabrir o Kanban.
            var naGaveta = history.state && history.state.icPainel;
            try { (naGaveta ? history.replaceState : history.pushState).call(history, { icCard: id }, '', rota); } catch (e) { location.hash = rota; }
        }
        var r = abrirCardBase.apply(this, arguments);
        window.scrollTo(0, 0);   // o card abre no topo, não na rolagem que o Kanban tinha
        return r;
    };

    // "Abrir card completo" na gaveta: fecha a gaveta SEM history.back() (que corria contra o
    // pushState do card e devolvia ao Kanban) e abre a rota do card.
    window.icAbrirCardDaConversa = function () {
        var id = window._jxPainelId || window._crmConversaModalId;
        window._jxVeioDaConversa = false;
        fecharModalConversaCRM(true);
        if (id) window.openCRMDetalhe(id);
    };

    window.icVoltarAoPipeline = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (history.state && history.state.icCard) { history.back(); return; }   // veio do Kanban: voltar pelo histórico
        // abriu por link ou recarga: não há Kanban atrás no histórico
        icGravarHash(icHashPipeline(), true);
        icRotear();
    };

    // Ao voltar para o Kanban, devolve a rolagem. A troca para o Kanban dispara loadCRM.
    envolver('showView', function (viewId) {
        if (viewId === 'view-crm' && window._icKanbanEstado) icRestaurarRolagemKanban();
    });

    // =====================================================================
    // 9b. ROTEADOR POR HASH: uma rota por tela, a URL é a única fonte da verdade (Correção 9)
    // =====================================================================
    // Causa raiz do "F5 abre o card de um cliente": o menu trocava a tela sem tocar na URL, então a hash
    // #/card/<id> continuava lá depois de sair do card. No reload, o trecho "link direto" (acima, versão
    // anterior) lia essa hash, gravava ic_last_view='view-crm-detalhe' e ic_crm_detalhe_id=<id> no
    // localStorage, e o checkSession reabria o card. Além disso o sistema guardava a última tela e o último
    // card em localStorage, uma segunda fonte da verdade que discordava da URL. Agora:
    //  - toda tela tem rota própria e showView atualiza a hash (pushState ao trocar de tela, replaceState em filtro);
    //  - o boot e o login passam por icRotear(), que lê a hash e valida permissão;
    //  - ic_last_view e ic_crm_detalhe_id deixaram de existir.
    var ROTAS = {
        'pipeline': 'view-crm', 'leads': 'view-leads', 'acoes-do-dia': 'view-acoes-dia', 'agendamentos': 'view-agendamentos',
        'usuarios': 'view-usuarios', 'permissoes': 'view-permissoes', 'redistribuir': 'view-redistribuir-leads',
        'funis': 'view-pipelines', 'historico': 'view-audit-log', 'perfil': 'view-meu-perfil'
    };
    var VIEW_PARA_ROTA = {};
    Object.keys(ROTAS).forEach(function (k) { VIEW_PARA_ROTA[ROTAS[k]] = k; });
    var ABAS_LEADS = ['entrada', 'atendimento', 'origem', 'vendas', 'jornada'];
    var ROTAS_ANTIGAS = { 'view-jornada-lead': '#/leads/jornada', 'view-analise-leads': '#/leads/origem' };
    var _roteando = false;
    // Limpa o que versões anteriores gravaram: a URL é a fonte da verdade, não o storage.
    try { localStorage.removeItem('ic_last_view'); localStorage.removeItem('ic_crm_detalhe_id'); } catch (e) { /* storage bloqueado: sem efeito */ }

    // Lê a hash. tipo: 'card' | 'tela' | 'invalida' | 'vazio'.
    window.icParseHash = function (h) {
        h = h == null ? (location.hash || '') : h;
        if (h.indexOf('#card=') === 0) { var c = h.slice(6).split('&')[0]; return { tipo: 'card', id: UUID.test(c) ? c : null, legado: true }; }
        if (h.indexOf('#/') !== 0) return { tipo: 'vazio' };
        var partes = h.slice(2).split('?');
        var seg = partes[0].split('/').filter(Boolean);
        var q = {};
        (partes[1] || '').split('&').forEach(function (par) {
            if (!par) return;
            var kv = par.split('=');
            try { q[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) { /* parâmetro ilegível: ignora */ }
        });
        if (seg[0] === 'card') return { tipo: 'card', id: UUID.test(seg[1] || '') ? seg[1] : null };
        if (ROTAS[seg[0]]) return { tipo: 'tela', rota: seg[0], view: ROTAS[seg[0]], sub: seg[1] || '', q: q };
        return { tipo: 'invalida' };
    };

    // Estado do Pipeline na URL: funil e filtros principais.
    window.icHashPipeline = function () {
        var q = [];
        function add(k, v) { if (v) q.push(k + '=' + encodeURIComponent(v)); }
        add('funil', window.crmCurrentPipelineId);
        var sel = document.getElementById('crm-filtro-vendedor-pro');
        add('resp', sel ? sel.value : (window._icRespInicial || ''));
        var fb = window._crmFiltrosBarra || {};
        add('temp', fb.temp); add('valor', fb.valor); add('origem', fb.origem);
        add('periodo', window._crmPeriodo);
        if (window._crmPeriodo === 'personalizado') { add('de', window._crmPeriodoIni); add('ate', window._crmPeriodoFim); }
        return '#/pipeline' + (q.length ? '?' + q.join('&') : '');
    };
    function icAplicarQueryPipeline(q) {
        if (q.funil && UUID.test(q.funil)) window.crmCurrentPipelineId = q.funil;
        window._icRespInicial = q.resp || '';
        var s = document.getElementById('crm-filtro-vendedor-pro'); if (s) s.value = q.resp || '';
        window._crmFiltrosBarra = { temp: q.temp || '', valor: q.valor || '', origem: q.origem || '', contrato: '' };
        window._crmPeriodo = q.periodo || '';
        if (q.periodo === 'personalizado') { window._crmPeriodoIni = q.de || ''; window._crmPeriodoFim = q.ate || ''; }
    }

    // pushState muda a URL sem recarregar. Preserva history.state (a gaveta do card guarda uma marca nele).
    function icGravarHash(hash, substituir) {
        if (location.hash === hash) return;
        try {
            if (substituir) history.replaceState(history.state, '', hash);
            else history.pushState(null, '', hash);
        } catch (e) { location.hash = hash; }
    }
    function icCaminho(hash) { return String(hash || '').split('?')[0].split('/').slice(0, 2).join('/'); }
    window.icGravarHash = icGravarHash;

    // Toda troca de tela (menu, botões, código) passa por showView: é aqui que a URL acompanha.
    envolver('showView', function (viewId) {
        if (_roteando || viewId === 'view-login' || viewId === 'view-crm-detalhe') return;
        var alvo = ROTAS_ANTIGAS[viewId] || (viewId === 'view-crm' ? icHashPipeline() : (VIEW_PARA_ROTA[viewId] ? '#/' + VIEW_PARA_ROTA[viewId] : null));
        if (!alvo) return;
        icGravarHash(alvo, icCaminho(location.hash) === icCaminho(alvo));   // tela nova = entrada de histórico; mesma tela = só atualiza
    });

    // Mantém a hash do Pipeline em dia quando o funil ou um filtro muda (replaceState: não enche o histórico).
    function icSincronizarHashPipeline() {
        var v = document.getElementById('view-crm');
        if (_roteando || !v || !v.classList.contains('active')) return;
        var h = icHashPipeline();
        if (location.hash.indexOf('#/pipeline') !== 0) return;   // outra rota assumiu: não sobrescreve
        icGravarHash(h, true);
        if (window._icRespInicial && document.getElementById('crm-filtro-vendedor-pro')) window._icRespInicial = '';
    }
    (function () {
        var o = window.loadCRM;
        if (typeof o !== 'function') return;
        window.loadCRM = function () {
            var r = o.apply(this, arguments);
            Promise.resolve(r).then(icSincronizarHashPipeline, icSincronizarHashPipeline);
            return r;
        };
    })();
    ['filtrarCRMPipeline', 'crmOnPeriodoData', 'crmOnPeriodo'].forEach(function (n) {
        envolver(n, function () { setTimeout(icSincronizarHashPipeline, 0); });
    });
    // Aba da tela Leads na URL.
    envolver('leadsIrParaSecao', function (secId) {
        if (_roteando || location.hash.indexOf('#/leads') !== 0) return;
        var sub = String(secId || '').replace('leads-sec-', '');
        icGravarHash(sub && sub !== 'entrada' ? '#/leads/' + sub : '#/leads', true);
    });

    function icViewAtiva(id) { var e = document.getElementById(id); return !!(e && e.classList.contains('active')); }

    // Rota inválida, card inexistente ou tela sem permissão: volta ao Pipeline, avisando quando há o que avisar.
    function icRedirecionarPipeline(mensagem) {
        if (mensagem && typeof showToast === 'function') showToast(mensagem, 'warning');
        _roteando = true;
        try { icGravarHash(icHashPipeline(), true); showView('view-crm'); } finally { _roteando = false; }
    }
    window.icCardIndisponivel = function () { icRedirecionarPipeline('Card não encontrado, ou você não tem permissão para vê-lo.'); };

    // Lê a hash e mostra a tela certa. Chamado no boot, depois do login, e a cada voltar/avançar do navegador.
    window.icRotear = function () {
        var p = icParseHash();
        if (p.tipo === 'card') {
            if (!p.id) return icRedirecionarPipeline('Card não encontrado.');
            if (p.legado) icGravarHash(ROTA_CARD + p.id, true);   // #card=<id> do Google Agenda vira #/card/<id>
            if (!icViewAtiva('view-crm-detalhe') || crmCurrentClienteId !== p.id) {
                _roteando = true;
                try { icAbrirSemEmpilhar(p.id); } finally { _roteando = false; }
            }
            return;
        }
        if (p.tipo === 'tela') {
            if (typeof podeVisualizar === 'function' && !podeVisualizar(p.view)) return icRedirecionarPipeline('Você não tem permissão para acessar esta tela.');
            var sub = p.view === 'view-leads' && ABAS_LEADS.indexOf(p.sub) >= 0 && p.sub !== 'entrada' ? 'leads-sec-' + p.sub : null;
            if (icViewAtiva(p.view)) {
                // já está na tela (voltar depois de fechar a gaveta, por exemplo): não recarrega, só vai à aba
                if (sub && typeof leadsIrParaSecao === 'function') { _roteando = true; try { leadsIrParaSecao(sub); } finally { _roteando = false; } }
                return;
            }
            _roteando = true;
            try {
                if (p.view === 'view-crm') icAplicarQueryPipeline(p.q);
                if (p.view === 'view-leads') window._jxAncoraPendente = sub;
                showView(p.view);
            } finally { _roteando = false; }
            return;
        }
        icRedirecionarPipeline(null);   // vazio ou inválida
    };
    window.icIrParaRotaInicial = window.icRotear;
    window.addEventListener('popstate', function () {
        if (!document.getElementById('app-authenticated') || document.getElementById('app-authenticated').style.display === 'none') return;   // sem sessão: o login decide depois
        icRotear();
    });

    // Esc no card completo volta ao Pipeline (campo editável trata o próprio Esc; modal e gaveta têm o seu).
    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' || ev.defaultPrevented || !icViewAtiva('view-crm-detalhe')) return;
        if (document.querySelector('.modal-overlay.active') || (typeof icPainelAberto === 'function' && icPainelAberto())) return;
        var a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
        icVoltarAoPipeline();
    });
    // Sair da conta limpa a rota: o próximo login começa em #/pipeline.
    // Também zera funil e filtros em memória: quem entra depois não herda o estado de quem saiu.
    envolver('handleLogout', function () {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        window.crmCurrentPipelineId = null; window._icRespInicial = ''; window._icKanbanEstado = null;
        window._crmFiltrosBarra = { temp: '', valor: '', origem: '', contrato: '' }; window._crmPeriodo = '';
        try { sessionStorage.removeItem('ic_kanban_estado'); } catch (e) {}
    });

    // =====================================================================
    // 10. EXCLUIR FUNIL (Parte 3.12): RPC transacional, só Admin, exclusão lógica
    // =====================================================================
    // Causa do "Excluir volta para a lista e nada acontece": a tela chamava crm_funis.delete() direto. Com RLS,
    // delete bloqueado devolve sucesso com 0 linhas; o botão ainda recarregava a lista sem esperar a exclusão
    // (excluirPipeline(id);loadGerenciarFunis()); e o confirm() nativo podia ser bloqueado. Agora tudo passa pela
    // RPC ic_funil_excluir (21_ic_funis.sql), que valida no banco e devolve erro de verdade.
    function icFecharModalFunil() {
        var m = document.getElementById('modal-ic-excluir-funil');
        if (!m) return;
        m.classList.remove('active');
        setTimeout(function () { m.remove(); }, 200);
    }
    function icAtualizarListasDeFunis(idExcluido) {
        window.crmPipelines = [];
        if (window.crmCurrentPipelineId === idExcluido) window.crmCurrentPipelineId = null;
        var ativa = function (id) { var e = document.getElementById(id); return e && e.classList.contains('active'); };
        if (ativa('view-pipelines') && typeof loadPipelines === 'function') loadPipelines();
        if (ativa('modal-gerenciar-funis') && typeof loadGerenciarFunis === 'function') loadGerenciarFunis();
        if (ativa('view-crm') && typeof loadCRM === 'function') loadCRM();
    }
    function icMensagemDeErro(error) {
        var msg = (error && (error.message || error.details)) || 'erro desconhecido';
        return String(msg).replace(/^ERRO:\s*/, '');
    }
    function icPluralCards(n) { return n + (n === 1 ? ' card' : ' cards'); }

    window.icExcluirFunil = async function (id) {
        var r = await supabaseClient.rpc('ic_funil_resumo', { p_funil: id });
        if (r.error || !r.data) { showToast('Não foi possível excluir: ' + icMensagemDeErro(r.error), 'error'); return; }
        var res = r.data;
        var m = document.getElementById('modal-ic-excluir-funil');
        if (m) m.remove();
        m = document.createElement('div');
        m.className = 'modal-overlay';
        m.id = 'modal-ic-excluir-funil';
        var card = document.createElement('div');
        card.className = 'modal-card';
        card.style.maxWidth = '480px';
        m.appendChild(card);

        var cab = document.createElement('div');
        cab.className = 'modal-header';
        var h2 = document.createElement('h2'); h2.textContent = 'Excluir funil';
        var x = document.createElement('button'); x.type = 'button'; x.className = 'modal-close'; x.setAttribute('aria-label', 'Fechar'); x.innerHTML = '&times;'; x.onclick = icFecharModalFunil;
        cab.appendChild(h2); cab.appendChild(x); card.appendChild(cab);

        var corpo = document.createElement('div');
        corpo.style.cssText = 'font-size:14px;line-height:1.6;color:var(--ic-text)';
        card.appendChild(corpo);
        var rodape = document.createElement('div'); rodape.className = 'modal-footer'; card.appendChild(rodape);
        var btnCancelar = document.createElement('button'); btnCancelar.type = 'button'; btnCancelar.className = 'btn btn-secondary'; btnCancelar.textContent = 'Cancelar'; btnCancelar.onclick = icFecharModalFunil;

        var temVinculo = (res.cards || 0) > 0 || (res.numeros_whatsapp || 0) > 0;
        var selDestino = null;

        if (res.ultimo_ativo) {
            // não há o que confirmar: o banco recusaria
            var p0 = document.createElement('p'); p0.textContent = 'Este é o último funil ativo e não pode ser excluído. Crie ou ative outro funil antes.';
            corpo.appendChild(p0);
            btnCancelar.textContent = 'Entendi'; rodape.appendChild(btnCancelar);
        } else {
            var p1 = document.createElement('p');
            if (temVinculo) {
                var partes = [];
                if (res.cards > 0) partes.push('Este funil tem ' + icPluralCards(res.cards) + '.');
                if (res.numeros_whatsapp > 0) partes.push('Ele também recebe o WhatsApp de ' + res.numeros_whatsapp + (res.numeros_whatsapp === 1 ? ' número' : ' números') + '.');
                partes.push('Mova-os para outro funil antes de excluir.');
                p1.textContent = partes.join(' ');
                corpo.appendChild(p1);
                if (!res.destinos || !res.destinos.length) {
                    var p2 = document.createElement('p'); p2.style.color = 'var(--ic-danger)'; p2.textContent = 'Não há outro funil ativo para receber os cards. Crie um funil antes.';
                    corpo.appendChild(p2);
                    btnCancelar.textContent = 'Entendi'; rodape.appendChild(btnCancelar);
                } else {
                    var grupo = document.createElement('div'); grupo.className = 'form-group'; grupo.style.marginTop = '12px';
                    var lbl = document.createElement('label'); lbl.textContent = 'Funil de destino'; lbl.htmlFor = 'ic-funil-destino';
                    selDestino = document.createElement('select'); selDestino.className = 'form-select'; selDestino.id = 'ic-funil-destino';
                    res.destinos.forEach(function (d) { var o = document.createElement('option'); o.value = d.id; o.textContent = d.nome; selDestino.appendChild(o); });
                    grupo.appendChild(lbl); grupo.appendChild(selDestino); corpo.appendChild(grupo);
                    var dica = document.createElement('p'); dica.style.cssText = 'font-size:12px;color:var(--ic-muted)';
                    dica.textContent = 'Fechados e perdidos entram no destino do jeito que estão (incluindo os excluídos). Cards em etapas que não existem no destino vão para a primeira etapa dele. Tudo acontece numa única operação: se algo falhar, nada é movido.';
                    corpo.appendChild(dica);
                }
            } else {
                p1.textContent = 'Excluir o funil "' + res.nome + '"? Ele sai da lista e do Kanban. As etapas e o histórico ficam preservados para consulta.';
                corpo.appendChild(p1);
            }
            if (!rodape.childNodes.length) {
                rodape.appendChild(btnCancelar);
                var btnOk = document.createElement('button'); btnOk.type = 'button'; btnOk.className = 'btn ic-destrutivo';
                btnOk.textContent = temVinculo ? 'Mover e excluir' : 'Excluir';
                btnOk.onclick = async function () {
                    btnOk.disabled = true; btnOk.textContent = 'Excluindo...';
                    var destino = selDestino ? selDestino.value : null;
                    var rr = await supabaseClient.rpc('ic_funil_excluir', { p_funil: id, p_destino: destino });
                    // erro de verdade do banco (permissão, último funil, conflito de telefone...). Nunca "sucesso" sem confirmação.
                    if (rr.error || !rr.data || rr.data.ok !== true) {
                        showToast('Não foi possível excluir: ' + icMensagemDeErro(rr.error), 'error');
                        btnOk.disabled = false; btnOk.textContent = temVinculo ? 'Mover e excluir' : 'Excluir';
                        return;
                    }
                    icFecharModalFunil();
                    var d = rr.data;
                    showToast('Funil "' + d.funil + '" excluído.' + (d.cards_movidos > 0 ? ' ' + icPluralCards(d.cards_movidos) + ' movido' + (d.cards_movidos === 1 ? '' : 's') + ' para "' + d.destino + '".' : ''), 'success');
                    icAtualizarListasDeFunis(id);
                };
                rodape.appendChild(btnOk);
            }
        }
        m.onclick = function (e) { if (e.target === m) icFecharModalFunil(); };
        document.body.appendChild(m);
        requestAnimationFrame(function () { m.classList.add('active'); });
    };
    // a tela chama excluirPipeline(id) de dois botões (tela de funis e modal Gerenciar Funis)
    window.excluirPipeline = window.icExcluirFunil;

    // =====================================================================
    // 11. ANOTAÇÕES, OBSERVAÇÕES E TIMELINE: uma carga, uma renderização, dois lugares
    // =====================================================================
    // Causas do "adicionar não faz nada" e da timeline que não atualiza:
    //  - o campo do painel e o da timeline do card completo tinham o MESMO id (crm-anotacao-input). Com o card
    //    já renderizado, getElementById devolvia o campo escondido (vazio) e crmAddAnotacao saía em silêncio;
    //  - o resultado do insert nunca era conferido (RLS bloqueada devolve 0 linhas sem erro);
    //  - crmSalvarObs gravava o evento e não redesenhava a timeline nem o painel;
    //  - o painel e o card montavam a lista cada um com seu laço.
    // Agora: icCarregarHistorico (uma consulta), icItemHistorico (um normalizador), dois renderizadores que
    // consomem o mesmo array (painel e timeline), e icAtualizarHistorico, que redesenha TODO lugar montado.
    var HIST_LIMITE = 300;
    var _autorCache = null;
    window.icAutorAtual = async function () {
        if (_autorCache) return _autorCache;
        var email = (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || '';
        try {
            var r = await supabaseClient.from('users').select('name').eq('email', email).maybeSingle();
            _autorCache = (r.data && r.data.name) || email || 'Sistema';
        } catch (e) { _autorCache = email || 'Sistema'; }
        return _autorCache;
    };
    window.icCarregarHistorico = async function (clienteId) {
        var r = await supabaseClient.from('crm_historico').select('*').eq('cliente_id', clienteId)
            .order('created_at', { ascending: false }).limit(HIST_LIMITE);
        if (r.error) throw r.error;
        return r.data || [];
    };
    function icDataHora(iso) {
        if (!iso) return '';
        try {
            return new Date(String(iso).replace(' ', 'T')).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return String(iso); }
    }
    // Normaliza uma linha de crm_historico: tudo que a tela mostra sai daqui.
    window.icItemHistorico = function (x) {
        var tipo = x.tipo || 'etapa';
        var item = { id: x.id, tipo: tipo, titulo: '', texto: x.descricao || '', selo: '', ponto: 'dot-etapa', autor: x.usuario_nome || 'Sistema', quando: icDataHora(x.created_at) };
        if (!item.texto && x.etapa_nova) item.texto = 'Movido para ' + getEtapaLabel(x.etapa_nova);
        if (tipo === 'anotacao') item.ponto = 'dot-anotacao';
        else if (tipo === 'observacao') { item.ponto = 'dot-anotacao'; item.titulo = 'Observações atualizadas'; }
        else if (tipo === 'contato') item.ponto = 'dot-contato';
        else if (tipo === 'criacao') item.ponto = 'dot-criacao';
        else if (tipo === 'formulario') item.ponto = 'dot-formulario';
        else if (tipo === 'reentrada') { item.ponto = 'dot-contato'; item.selo = 'Reentrada'; }
        else if (tipo === 'reentrada_reconstruida') { item.ponto = 'dot-contato'; item.selo = 'Reentrada reconstruída'; }
        else if (tipo === 'alteracao') item.ponto = 'dot-anotacao';
        else if (tipo === 'reativacao') { item.ponto = 'dot-reativacao'; item.selo = 'Reativado automaticamente'; }
        else if (tipo === 'automatico') { item.ponto = 'dot-automatico'; item.selo = 'Automático'; }
        else if (tipo === 'ia') { item.ponto = 'dot-automatico'; item.selo = 'Assistente virtual'; }
        return item;
    }
    function esc(t) { return escapeHtml(t == null ? '' : String(t)); }
    function icPrevia(t, n) { t = String(t || '').trim(); return t.length > n ? t.slice(0, n).trimEnd() + '…' : t; }

    // Renderizador 1: linha do tempo do card completo (também usada na criação inicial do card).
    window.icTimelineInnerHtml = function (hist, criadoEm) {
        var h = '';
        if (!hist.length) {
            h += '<div class="crm-timeline-item"><div class="crm-timeline-dot dot-criacao"></div><div class="crm-timeline-text">Cliente criado</div><div class="crm-timeline-date">' + esc(criadoEm) + '</div></div>';
            return h;
        }
        hist.forEach(function (x) {
            var it = icItemHistorico(x);
            h += '<div class="crm-timeline-item" data-hist-id="' + esc(it.id) + '"><div class="crm-timeline-dot ' + it.ponto + '"></div><div class="crm-timeline-text">';
            if (it.selo) h += '<span class="ic-selo-automatico">' + esc(it.selo) + '</span> ';
            if (it.titulo) {
                h += '<strong>' + esc(it.titulo) + '</strong>';
                if (it.texto) h += '<div class="ic-hist-previa">' + esc(icPrevia(it.texto, 220)) + '</div>';
            } else {
                h += '<span style="white-space:pre-wrap;word-break:break-word">' + esc(it.texto) + '</span>';
            }
            h += '</div><div class="crm-timeline-date">' + esc(it.quando) + ' — ' + esc(it.autor) + '</div></div>';
        });
        h += '<div class="crm-timeline-item"><div class="crm-timeline-dot dot-criacao"></div><div class="crm-timeline-text"><strong>Cliente criado</strong></div><div class="crm-timeline-date">' + esc(criadoEm) + '</div></div>';
        return h;
    };
    // Renderizador 2: linhas do painel lateral (aba Anotações usa só anotações e observações; Atividades usa tudo).
    window.icPainelLinhaHtml = function (x) {
        var it = icItemHistorico(x);
        var corpo = it.titulo ? '<strong>' + esc(it.titulo) + '</strong>' + (it.texto ? '<div class="ic-hist-previa">' + esc(icPrevia(it.texto, 220)) + '</div>' : '')
                              : (it.selo ? '<span class="ic-selo-automatico">' + esc(it.selo) + '</span> ' : '') + esc(it.texto);
        return '<div class="ic-hist-linha" data-hist-id="' + esc(it.id) + '">'
            + '<div class="ic-hist-texto">' + corpo + '</div>'
            + '<div class="ic-hist-meta">' + esc(it.autor) + ' · ' + esc(it.quando) + '</div></div>';
    };
    window.icPainelLinhaHist = window.icPainelLinhaHtml;   // o painel passa a usar o renderizador comum

    // Redesenha TODO lugar montado com o histórico deste card. novaLinha opcional: aparece na hora (otimista),
    // e o recarregamento do banco confirma em seguida.
    window.icAtualizarHistorico = async function (clienteId, novaLinha) {
        var lista = null;
        var painelAberto = window._jxPainelId === clienteId && typeof icPainelAberto === 'function' && icPainelAberto();
        var base = painelAberto ? (window._jxPainelHist || []) : null;
        var tl = document.getElementById('ic-timeline');
        if (!base && tl && tl.dataset.cliente === clienteId) base = tl._hist || [];
        if (novaLinha) {
            lista = [novaLinha].concat((base || []).filter(function (x) { return x.id !== novaLinha.id; }));
            icMontarHistorico(clienteId, lista);
        }
        try { lista = await icCarregarHistorico(clienteId); }
        catch (e) { console.warn('[ic] histórico não recarregou:', e && e.message); return; }
        icMontarHistorico(clienteId, lista);
    };
    function icMontarHistorico(clienteId, lista) {
        if (window._jxPainelId === clienteId && typeof icPainelAberto === 'function' && icPainelAberto()) {
            window._jxPainelHist = lista;
            var tinhaFoco = document.activeElement && document.activeElement.id === 'icp-anotacao-input';
            if (typeof icPainelRenderAba === 'function') icPainelRenderAba();
            if (tinhaFoco) { var ni = document.getElementById('icp-anotacao-input'); if (ni) ni.focus(); }
        }
        var tl = document.getElementById('ic-timeline');
        if (tl && tl.dataset.cliente === clienteId) { tl._hist = lista; tl.innerHTML = icTimelineInnerHtml(lista, tl.dataset.criado || ''); }
    }

    function icMsgErro(e) { return String((e && (e.message || e.details)) || 'erro desconhecido').replace(/^ERRO:\s*/, ''); }
    function icErroCampo(el, msg) {
        var id = (el.id || 'campo') + '-erro', n = document.getElementById(id);
        if (!n) { n = document.createElement('div'); n.id = id; n.style.cssText = 'color:var(--ic-danger);font-size:12px;margin-top:4px;width:100%'; var linha = el.closest('.crm-edit-inline, .icp-linha'); (linha || el).insertAdjacentElement('afterend', n); }
        n.textContent = msg;
        el.style.setProperty('border-color', 'var(--ic-danger)', 'important');
        el.addEventListener('input', function limpar() { n.remove(); el.style.removeProperty('border-color'); el.removeEventListener('input', limpar); });
    }

    // Adicionar anotação: 'painel' (gaveta) ou 'card' (timeline do card completo). Cada um tem o SEU campo.
    var _enviandoNota = false;
    window.icAdicionarAnotacao = async function (origem) {
        if (_enviandoNota) return;
        var input = document.getElementById(origem === 'painel' ? 'icp-anotacao-input' : 'crm-anotacao-input');
        if (!input) return;
        var clienteId = origem === 'painel' ? window._jxPainelId : crmCurrentClienteId;
        if (!clienteId) return;
        var texto = input.value.trim();
        if (!texto) { input.value = ''; icErroCampo(input, 'Escreva a anotação antes de adicionar.'); input.focus(); return; }
        if (texto.length > 2000) { icErroCampo(input, 'A anotação passa de 2000 caracteres.'); return; }
        var btn = input.parentElement.querySelector('button');
        _enviandoNota = true; input.disabled = true;
        if (btn && typeof setBtnLoading === 'function') setBtnLoading(btn, true);
        try {
            var autor = await icAutorAtual();
            // .select().single(): sem isso, RLS bloqueando devolveria "sucesso" com 0 linhas
            var r = await supabaseClient.from('crm_historico').insert({ cliente_id: clienteId, tipo: 'anotacao', descricao: texto, usuario_nome: autor }).select().single();
            if (r.error || !r.data) { showToast('Não foi possível salvar a anotação: ' + icMsgErro(r.error || { message: 'sem permissão para este card' }), 'error'); return; }
            input.value = '';
            showToast('Anotação adicionada', 'success');
            await icAtualizarHistorico(clienteId, r.data);
        } catch (e) {
            console.error('[ic] anotação:', e);
            showToast('Não foi possível salvar a anotação: ' + icMsgErro(e), 'error');
        } finally {
            _enviandoNota = false;
            var ni = document.getElementById(origem === 'painel' ? 'icp-anotacao-input' : 'crm-anotacao-input');
            if (ni) { ni.disabled = false; ni.focus(); var nb = ni.parentElement.querySelector('button'); if (nb && typeof setBtnLoading === 'function') setBtnLoading(nb, false); }
        }
    };
    window.crmAddAnotacao = function () { return icAdicionarAnotacao('card'); };   // compatibilidade com chamadas antigas

    // Salvar observações: confere a linha gravada, registra o evento e redesenha timeline e painel.
    var _salvandoObs = false;
    window.icSalvarObservacoes = async function () {
        if (_salvandoObs) return;
        var ta = document.getElementById('crm-obs-textarea');
        var clienteId = crmCurrentClienteId;
        if (!ta || !clienteId) return;
        var obs = ta.value.replace(/\s+$/, '');
        if (obs.length > 5000) { icErroCampo(ta, 'As observações passam de 5000 caracteres.'); return; }
        if (ta.dataset.salvo !== undefined && ta.dataset.salvo === obs) { showToast('Nada mudou nas observações.', 'info'); return; }
        var btn = ta.parentElement.querySelector('button.btn-primary');
        _salvandoObs = true;
        if (btn && typeof setBtnLoading === 'function') setBtnLoading(btn, true);
        try {
            var up = await supabaseClient.from('clientes_crm').update({ observacoes: obs, updated_at: new Date().toISOString() }).eq('id', clienteId).select('id');
            if (up.error || !up.data || up.data.length === 0) { showToast('Não foi possível salvar as observações: ' + icMsgErro(up.error || { message: 'sem permissão para este card' }), 'error'); return; }
            ta.dataset.salvo = obs; ta.value = obs;
            var autor = await icAutorAtual();
            var ev = await supabaseClient.from('crm_historico').insert({ cliente_id: clienteId, tipo: 'observacao', descricao: obs, usuario_nome: autor }).select().single();
            window._crmObsTextoCache = window._crmObsTextoCache || {}; window._crmObsAutorCache = window._crmObsAutorCache || {};
            window._crmObsTextoCache[clienteId] = obs;
            window._crmObsAutorCache[clienteId] = { usuario_nome: autor, created_at: new Date().toISOString() };
            if (ev.error || !ev.data) { showToast('Observações salvas, mas o evento não entrou na timeline: ' + icMsgErro(ev.error), 'warning'); return; }
            showToast('Observações salvas!', 'success');
            await icAtualizarHistorico(clienteId, ev.data);
        } catch (e) {
            console.error('[ic] observações:', e);
            showToast('Não foi possível salvar as observações: ' + icMsgErro(e), 'error');
        } finally {
            _salvandoObs = false;
            if (btn && typeof setBtnLoading === 'function') setBtnLoading(btn, false);
        }
    };
    window.crmSalvarObs = window.icSalvarObservacoes;

    // Teclado: Enter envia anotação (input); Ctrl/Cmd+Enter salva observações (textarea; Enter quebra linha).
    window.icTeclaAnotacao = function (ev, origem) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); icAdicionarAnotacao(origem); } };
    window.icTeclaObservacoes = function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) { ev.preventDefault(); icSalvarObservacoes(); } };

    // Tempo real: anotação feita por outro usuário aparece sem recarregar (22_ic_historico_realtime.sql).
    var _canalHist = null;
    window.icOnHistoricoInsert = function (payload) {
        var novo = payload && payload.new; if (!novo || !novo.cliente_id) return;
        var aberto = (window._jxPainelId === novo.cliente_id) || (document.getElementById('ic-timeline') && document.getElementById('ic-timeline').dataset.cliente === novo.cliente_id);
        if (!aberto) return;
        var tl = document.getElementById('ic-timeline');
        var atual = (window._jxPainelId === novo.cliente_id ? window._jxPainelHist : (tl && tl._hist)) || [];
        if (atual.some(function (x) { return x.id === novo.id; })) return;   // é a nossa própria gravação
        icAtualizarHistorico(novo.cliente_id);
    };
    window.icAssinarHistorico = function () {
        if (_canalHist || typeof supabaseClient.channel !== 'function') return;
        try {
            _canalHist = supabaseClient.channel('ic-historico')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crm_historico' }, icOnHistoricoInsert)
                .subscribe();
        } catch (e) { console.warn('[ic] canal de histórico indisponível:', e && e.message); }
    };
    envolver('icAbrirPainelLead', function () { icAssinarHistorico(); });
    envolver('openCRMDetalhe', function () { icAssinarHistorico(); });

    // =====================================================================
    // 12. CADASTRO: máscaras, validação e gravação campo a campo (CPF, e-mail, origem, profissão)
    // =====================================================================
    window.icOrigemSelectHtml = function (id, valor) {
        var chave = icOrigemChave(valor), h = '<select id="' + esc(id) + '" data-original="' + esc(chave || '') + '">';
        h += '<option value=""' + (chave ? '' : ' selected') + '>Selecione...</option>';
        IC_ORIGENS.forEach(function (o) { h += '<option value="' + o.chave + '"' + (o.chave === chave ? ' selected' : '') + '>' + esc(o.rotulo) + '</option>'; });
        if (valor && !chave) h += '<option value="" disabled selected>' + esc(valor) + ' (fora da lista)</option>';
        return h + '</select>';
    };

    // Máscara ao digitar e ao colar, para todo campo marcado com data-ic-mask (cpf | tel).
    document.addEventListener('input', function (ev) {
        var el = ev.target, tipo = el && el.getAttribute && el.getAttribute('data-ic-mask');
        if (!tipo || el.tagName !== 'INPUT') return;
        var novo = tipo === 'cpf' ? icCpfMascara(el.value) : tipo === 'tel' ? icTelefoneMascara(el.value) : el.value;
        if (novo !== el.value) el.value = novo;
    });
    // CPF: ao sair do campo já avisa se está inválido (só quando completo ou com algo digitado).
    document.addEventListener('focusout', function (ev) {
        var el = ev.target;
        if (!el || !el.getAttribute || el.getAttribute('data-ic-mask') !== 'cpf' || !el.value) return;
        var r = icCpfNormalizar(el.value);
        if (!r.ok && el.id) icErroCampo(el, r.erro);
    });

    var _salvandoCampo = false;
    window.icTeclaCampoCadastro = function (ev, campo, el) {
        if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); var b = el.parentElement.querySelector('button'); if (b) icSalvarCampoCadastro(campo, b); }
        else if (ev.key === 'Escape') { el.value = el.getAttribute('data-original') || ''; var n = document.getElementById(el.id + '-erro'); if (n) n.remove(); el.style.removeProperty('border-color'); el.blur(); }
    };
    // Botão OK de cada campo: valida, grava, confere que 1 linha mudou, confirma com toast; em erro, volta o valor anterior.
    window.icSalvarCampoCadastro = async function (campo, btn) {
        if (_salvandoCampo) return;
        var el = btn.parentElement.querySelector('input,select');
        var clienteId = crmCurrentClienteId;
        if (!el || !clienteId) return;
        var anterior = el.getAttribute('data-original') || '';
        var novo, exibir;
        if (campo === 'cpf') {
            var c = icCpfNormalizar(el.value);
            if (!c.ok) { icErroCampo(el, c.erro); el.focus(); return; }
            novo = c.valor; exibir = c.valor ? icCpfMascara(c.valor) : '';
        } else if (campo === 'email') {
            var m = icEmailNormalizar(el.value);
            if (!m.ok) { icErroCampo(el, m.erro); el.focus(); return; }
            novo = m.valor; exibir = m.valor || '';
        } else if (campo === 'origem') {
            novo = el.value || null; exibir = novo || '';
            if (novo && !icOrigemChave(novo)) { showToast('Escolha uma origem da lista.', 'warning'); return; }
        } else {
            novo = el.value.trim() || null; exibir = novo || '';
            if (exibir.length > 100) { icErroCampo(el, 'Máximo de 100 caracteres.'); return; }
        }
        if (exibir === anterior) { el.value = exibir; showToast('Nada mudou.', 'info'); return; }
        var rotulo = { cpf: 'CPF', email: 'E-mail', origem: 'Origem', profissao: 'Profissão' }[campo] || campo;
        _salvandoCampo = true; btn.disabled = true; el.disabled = true;
        try {
            var upd = {}; upd[campo] = novo; upd.updated_at = new Date().toISOString();
            var r = await supabaseClient.from('clientes_crm').update(upd).eq('id', clienteId).select('id');
            if (r.error || !r.data || !r.data.length) {
                el.value = anterior;   // volta o valor que valia
                var msg = r.error ? icMsgErro(r.error) : 'sem permissão para este card';
                showToast('Não foi possível salvar ' + rotulo + ': ' + msg, 'error');
                return;
            }
            el.value = exibir; el.setAttribute('data-original', exibir);
            var nn = document.getElementById(el.id + '-erro'); if (nn) nn.remove(); el.style.removeProperty('border-color');
            showToast(rotulo + (campo === 'origem' ? ' atualizada.' : ' atualizado.'), 'success');
            if (campo === 'origem') crmRefrescarDetalhe(clienteId);
        } catch (e) {
            el.value = anterior;
            showToast('Não foi possível salvar ' + rotulo + ': ' + icMsgErro(e), 'error');   // sem o valor do campo: LGPD
        } finally {
            _salvandoCampo = false; btn.disabled = false; el.disabled = false;
        }
    };
    // =====================================================================
    // 13. AUDITORIA DE CAMPOS (item 8): nome do lead, meu perfil, teclado, limites
    // =====================================================================
    // Nome do lead (campo do título do card): salvava ao sair do campo, sem conferir 0 linhas e sem voltar o
    // valor quando falhava (a tela ficava com um nome que o banco não tinha).
    var _salvandoNome = false;
    window.icTeclaNomeLead = function (ev, el) {
        if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); el.blur(); }
        else if (ev.key === 'Escape') { el.value = el.getAttribute('data-original') || ''; el.blur(); }
    };
    window.salvarNomeLead = async function (clienteId, novoNome) {
        var el = document.getElementById('crm-detalhe-nome');
        var anterior = el ? (el.getAttribute('data-original') || '') : '';
        var nome = String(novoNome == null ? '' : novoNome).replace(/\s+/g, ' ').trim();
        if (!nome) { if (el) el.value = anterior; if (anterior) showToast('O nome não pode ficar vazio.', 'warning'); return; }
        if (nome === anterior || _salvandoNome) { if (el) el.value = nome; return; }
        if (nome.length > 200) { if (el) el.value = anterior; showToast('O nome passa de 200 caracteres.', 'warning'); return; }
        _salvandoNome = true;
        try {
            var r = await supabaseClient.from('clientes_crm').update({ nome: nome, updated_at: new Date().toISOString() }).eq('id', clienteId).select('id');
            if (r.error || !r.data || !r.data.length) {
                if (el) el.value = anterior;
                showToast('Não foi possível salvar o nome: ' + (r.error ? icMsgErro(r.error) : 'sem permissão para este card'), 'error');
                return;
            }
            if (el) { el.value = nome; el.setAttribute('data-original', nome); }
            var autor = await icAutorAtual();
            var h = await supabaseClient.from('crm_historico').insert({ cliente_id: clienteId, tipo: 'alteracao', descricao: 'Nome alterado de "' + (anterior || 'vazio') + '" para "' + nome + '"', usuario_nome: autor });
            if (h.error) { showToast('Nome salvo, mas o histórico não gravou: ' + icMsgErro(h.error), 'warning'); return; }
            showToast('Nome atualizado.', 'success');
            icAtualizarHistorico(clienteId);
        } catch (e) {
            if (el) el.value = anterior;
            showToast('Não foi possível salvar o nome: ' + icMsgErro(e), 'error');
        } finally { _salvandoNome = false; }
    };

    // Meu perfil: update de users sem .select() fazia "sucesso" mesmo com RLS bloqueando (0 linhas).
    var _salvandoPerfil = false;
    window.salvarPerfil = async function () {
        if (_salvandoPerfil || typeof currentUser === 'undefined' || !currentUser) return;
        var campo = document.getElementById('perfil-nome');
        var btn = document.getElementById('btn-salvar-perfil');
        var nome = campo.value.replace(/\s+/g, ' ').trim();
        if (!nome) { icErroCampo(campo, 'Informe seu nome.'); campo.focus(); return; }
        if (nome.length > 200) { icErroCampo(campo, 'Máximo de 200 caracteres.'); return; }
        _salvandoPerfil = true; setBtnLoading(btn, true);
        try {
            var r = await supabaseClient.from('users').update({ name: nome }).eq('email', currentUser.email).select('id');
            if (r.error || !r.data || !r.data.length) { showToast('Não foi possível salvar o perfil: ' + (r.error ? icMsgErro(r.error) : 'sem permissão'), 'error'); return; }
            campo.value = nome; _autorCache = null;
            showToast('Perfil atualizado.', 'success');
            var g = document.getElementById('dashboard-greeting'); if (g) g.textContent = 'Olá, ' + nome + ' 👋';
        } catch (e) { showToast('Não foi possível salvar o perfil: ' + icMsgErro(e), 'error'); }
        finally { _salvandoPerfil = false; setBtnLoading(btn, false); }
    };

    // Limites de tamanho: todo campo de texto sem maxlength ganha um ao receber foco, para ninguém colar
    // 1 MB num nome. Tabela por id/name para os que têm limite próprio; os demais usam o padrão.
    var LIMITES = { 'np-nome': 100, 'edit-pipeline-nome': 100, 'edit-funil-nome': 100, 'edit-pipeline-nova-etapa': 60, 'pa-nome': 60, 'pa-descricao': 300,
        'perfil-nome': 200, 'leads-busca': 100, 'login-email': 254, 'name': 200, 'nome': 200, 'profissao': 100, 'observacoes': 2000, 'email': 254, 'password': 128, 'perfil-nova-senha': 128 };
    document.addEventListener('focusin', function (ev) {
        var el = ev.target;
        if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
        var tipo = (el.type || 'text').toLowerCase();
        if (['text', 'search', 'email', 'password', 'tel', 'url', ''].indexOf(tipo) < 0 && el.tagName !== 'TEXTAREA') return;
        if (el.maxLength > 0 && el.maxLength < 524288) return;
        el.maxLength = LIMITES[el.id] || LIMITES[el.name] || (el.tagName === 'TEXTAREA' ? 2000 : 200);
    });

    // Teclado: Esc fecha o modal do topo; Enter num campo de modal SEM <form> aciona o botão principal.
    document.addEventListener('keydown', function (ev) {
        if (ev.defaultPrevented || ev.isComposing) return;
        var abertos = document.querySelectorAll('.modal-overlay.active');
        if (!abertos.length) return;
        var topo = abertos[abertos.length - 1];
        if (ev.key === 'Escape') {
            if (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-original') !== null) return; // o campo trata o próprio Esc
            var fechar = topo.querySelector('.modal-close');
            if (fechar) fechar.click(); else if (topo.id === 'modal-dinamico') closeModal(); else closeModal(topo.id);
            ev.preventDefault();
        } else if (ev.key === 'Enter') {
            var a = document.activeElement;
            if (!a || a.tagName !== 'INPUT' || a.form || ['text', 'number', 'search', 'email', 'password', 'tel', 'date', 'time'].indexOf(a.type) < 0) return;
            var principal = topo.querySelector('.modal-footer button:not(.btn-secondary):not([data-ic="cancelar"]):not(.modal-close)');
            if (principal && !principal.disabled) { ev.preventDefault(); principal.click(); }
        }
    });

    // Proteção contra clique duplo: enquanto a gravação anterior não termina, nova chamada é ignorada.
    // Cobre funis, perfis, redistribuição, importação e agendamento, que não travavam o botão.
    ['salvarNovoPipeline', 'salvarPipelineEditado', 'salvarPerfilAcesso', 'executarRedistribuicao', 'importarLeadsCSV', 'icSalvarAgendamento', 'alterarSenha', 'salvarFunilEditado']
        .forEach(function (nome) {
            var orig = window[nome];
            if (typeof orig !== 'function') return;
            var emCurso = false;
            window[nome] = function () {
                if (emCurso) return;
                emCurso = true;
                var r;
                try { r = orig.apply(this, arguments); } catch (e) { emCurso = false; throw e; }
                return Promise.resolve(r).finally(function () { emCurso = false; });
            };
        });

    window.crmSalvarCampo = function (campo, valor) {   // compatibilidade: chamadas antigas pelo nome
        var el = document.getElementById('crm-edit-' + campo);
        if (el && el.parentElement.querySelector('button')) return icSalvarCampoCadastro(campo, el.parentElement.querySelector('button'));
    };
})();
