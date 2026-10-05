/* ic-validacao.js
 * Funções PURAS de cadastro: CPF, telefone, e-mail, origem, dinheiro (R$) e data.
 * Sem DOM e sem rede, para rodar igual no navegador e no Node (teste/testar-validacao.mjs).
 * O banco repete as regras críticas (23_ic_cadastro_padrao.sql): front é conforto, banco é a garantia.
 *
 * LGPD: nada aqui escreve CPF em log. icCpfMascararParaLog() existe para quem precisar registrar algo.
 */
(function (raiz) {
    'use strict';

    function digitos(t) { return String(t == null ? '' : t).replace(/\D/g, ''); }

    // ---------------------------------------------------------------- CPF
    // Só dígitos, no máximo 11 (colar "123.456.789-09" ou "12345678909" dá o mesmo).
    function icCpfDigitos(t) { return digitos(t).slice(0, 11); }

    // Máscara progressiva enquanto digita: 000.000.000-00
    function icCpfMascara(t) {
        var d = icCpfDigitos(t), s = d.slice(0, 3);
        if (d.length > 3) s += '.' + d.slice(3, 6);
        if (d.length > 6) s += '.' + d.slice(6, 9);
        if (d.length > 9) s += '-' + d.slice(9, 11);
        return s;
    }

    // Dígitos verificadores oficiais (módulo 11). Rejeita sequências repetidas (111.111.111-11 etc.).
    function icCpfValido(t) {
        var d = digitos(t);
        if (d.length !== 11) return false;
        if (/^(\d)\1{10}$/.test(d)) return false;
        for (var n = 9; n <= 10; n++) {
            var soma = 0;
            for (var i = 0; i < n; i++) soma += Number(d.charAt(i)) * (n + 1 - i);
            var dv = (soma * 10) % 11;
            if (dv === 10) dv = 0;
            if (dv !== Number(d.charAt(n))) return false;
        }
        return true;
    }

    // Devolve { ok, valor (11 dígitos ou null), erro }. Vazio é permitido (campo opcional).
    function icCpfNormalizar(t) {
        var d = digitos(t);
        if (!d) return { ok: true, valor: null, erro: null };
        if (!icCpfValido(d)) return { ok: false, valor: null, erro: 'CPF inválido' };
        return { ok: true, valor: d, erro: null };
    }

    // Exibição: sempre formatado. Se não tiver 11 dígitos (dado legado), mostra como veio.
    function icCpfFormatar(t) {
        var d = digitos(t);
        return d.length === 11 ? icCpfMascara(d) : (t == null ? '' : String(t));
    }

    // Para log: ***.***.***-09. Nunca registre o CPF inteiro.
    function icCpfMascararParaLog(t) {
        var d = digitos(t);
        return d.length === 11 ? '***.***.***-' + d.slice(9) : '***';
    }

    // ----------------------------------------------------------- TELEFONE
    // Armazenamento: E.164 sem "+", ex.: 5511984567712 (o webhook casa por esse formato).
    // Entrada aceita: (11) 98456-7712, 11984567712, +55 11 98456-7712, 1133334444 (fixo de 8 dígitos).
    function icTelefoneParaE164(t) {
        var d = digitos(t);
        if (!d) return null;
        if (d.length === 10 || d.length === 11) return '55' + d;
        if ((d.length === 12 || d.length === 13) && d.indexOf('55') === 0) return d;
        return null;
    }

    // Exibição: (11) 98456-7712 (celular) ou (11) 3333-4444 (fixo). Aceita DDI 55.
    // Número que não casa com nenhum formato (estrangeiro, legado) volta como veio.
    function icTelefoneFormatar(t) {
        var d = digitos(t);
        if (d.length >= 12 && d.indexOf('55') === 0) d = d.slice(2);
        if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
        if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
        return t == null ? '' : String(t);
    }

    // Máscara enquanto digita (sem DDI): (11) 98456-7712
    function icTelefoneMascara(t) {
        var d = digitos(t);
        if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
        d = d.slice(0, 11);
        var s = '';
        if (d.length) s = '(' + d.slice(0, 2);
        if (d.length >= 3) s += ') ' + d.slice(2, d.length > 10 ? 7 : 6);
        if (d.length > (d.length > 10 ? 7 : 6)) s += '-' + d.slice(d.length > 10 ? 7 : 6);
        return s;
    }

    function icTelefoneErro(t) {
        var d = digitos(t);
        if (!d) return 'Telefone é obrigatório.';
        var ddd = icTelefoneParaE164(d);
        if (!ddd) return 'Informe um telefone brasileiro com DDD: (11) 98456-7712.';
        var local = ddd.slice(2);
        if (local.charAt(0) === '0' || local.charAt(1) === '0') return 'DDD inválido.';
        if (local.length === 11 && local.charAt(2) !== '9') return 'Celular deve começar com 9 depois do DDD.';
        return null;
    }

    // ------------------------------------------------------------ E-MAIL
    var RE_EMAIL = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/;
    // Devolve { ok, valor (minúsculo, sem espaços, ou null), erro }. Vazio é permitido.
    function icEmailNormalizar(t) {
        var e = String(t == null ? '' : t).trim().toLowerCase();
        if (!e) return { ok: true, valor: null, erro: null };
        if (e.length > 254 || !RE_EMAIL.test(e) || e.indexOf('..') >= 0) return { ok: false, valor: null, erro: 'E-mail inválido' };
        return { ok: true, valor: e, erro: null };
    }

    // ------------------------------------------------------------ ORIGEM
    // Lista oficial. A chave é o que vai para o banco; o rótulo é o que a tela mostra.
    var IC_ORIGENS = [
        { chave: 'whatsapp', rotulo: 'WhatsApp' },
        { chave: 'indicacao', rotulo: 'Indicação' },
        { chave: 'lista_prospeccao', rotulo: 'Lista/Prospecção' },
        { chave: 'planilha', rotulo: 'Planilha' },
        { chave: 'importacao', rotulo: 'Importação' },
        { chave: 'evento', rotulo: 'Evento' },
        { chave: 'visita', rotulo: 'Visita' },
        { chave: 'manual', rotulo: 'Manual' },
        { chave: 'anuncio', rotulo: 'Anúncio' }
    ];
    function semAcento(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
    // Mapeamento explícito (o mesmo da migração 23). Devolve a chave ou null se não reconhecer.
    function icOrigemChave(t) {
        var o = semAcento(t).toLowerCase().trim().replace(/[\s\-\/]+/g, '_');
        if (!o) return null;
        for (var i = 0; i < IC_ORIGENS.length; i++) if (IC_ORIGENS[i].chave === o) return o;
        var mapa = [
            [/^(whats|wpp|zap)/, 'whatsapp'],
            [/^indica/, 'indicacao'],
            [/^(lista|prospec)/, 'lista_prospeccao'],
            [/^planilha/, 'planilha'],
            [/^(importa|csv)/, 'importacao'],
            [/^evento/, 'evento'],
            [/^visita/, 'visita'],
            [/^manual/, 'manual'],
            [/^(anuncio|ads|meta|instagram|facebook|google|site|formul)/, 'anuncio']
        ];
        for (var j = 0; j < mapa.length; j++) if (mapa[j][0].test(o)) return mapa[j][1];
        return null;
    }
    function icOrigemRotulo(t) {
        var k = icOrigemChave(t);
        if (!k) return t ? String(t) : '';
        for (var i = 0; i < IC_ORIGENS.length; i++) if (IC_ORIGENS[i].chave === k) return IC_ORIGENS[i].rotulo;
        return String(t);
    }

    // ----------------------------------------------------- DINHEIRO (R$)
    // Armazenamento: número (ex.: 1234.56). Exibição: R$ 1.234,56.
    // Máscara por "centavos": cada dígito digitado entra pela direita, como em maquininha.
    function icMoedaFormatar(n) {
        if (n == null || n === '' || isNaN(Number(n))) return '';
        var v = Math.round(Number(n) * 100) / 100, neg = v < 0;
        var partes = Math.abs(v).toFixed(2).split('.');
        partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        return (neg ? '-' : '') + 'R$ ' + partes[0] + ',' + partes[1];
    }
    function icMoedaMascara(t) {
        var d = digitos(t).replace(/^0+(?=\d)/, '');
        if (!d) return '';
        while (d.length < 3) d = '0' + d;
        return icMoedaFormatar(Number(d.slice(0, -2) + '.' + d.slice(-2)));
    }
    // Aceita "R$ 1.234,56", "1234,56", "1234.56", "1.234" (milhar). Devolve número ou null.
    function icMoedaParaNumero(t) {
        if (typeof t === 'number') return isFinite(t) ? Math.round(t * 100) / 100 : null;
        var s = String(t == null ? '' : t).replace(/R\$|\s/g, '');
        if (!s) return null;
        var neg = s.charAt(0) === '-';
        s = s.replace(/-/g, '');
        if (/,/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
        else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
        if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
        var n = Math.round(parseFloat(s) * 100) / 100;
        return neg ? -n : n;
    }

    // -------------------------------------------------------------- DATA
    // O banco guarda data (yyyy-mm-dd) ou timestamptz. Mostrar em America/Sao_Paulo e tratar
    // yyyy-mm-dd como DATA (sem fuso), senão "2026-10-05" vira 04/10 às 21h no Brasil.
    function icDataBR(t) {
        if (!t) return '';
        var s = String(t), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (m) return m[3] + '/' + m[2] + '/' + m[1];
        var d = new Date(s.replace(' ', 'T'));
        if (isNaN(d.getTime())) return s;
        return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    }
    // dd/mm/aaaa -> yyyy-mm-dd, ou null se a data não existe (31/02 etc.)
    function icDataParaIso(t) {
        var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(t || '').trim());
        if (!m) return null;
        var d = Number(m[1]), mes = Number(m[2]), a = Number(m[3]);
        var x = new Date(Date.UTC(a, mes - 1, d));
        if (x.getUTCFullYear() !== a || x.getUTCMonth() !== mes - 1 || x.getUTCDate() !== d) return null;
        return m[3] + '-' + m[2] + '-' + m[1];
    }

    // Dia civil (yyyy-mm-dd) em America/Sao_Paulo de um instante (Date ou ISO). Texto yyyy-mm-dd já é dia e volta igual.
    // Usar isto no lugar de toISOString().slice(0,10), que dá o dia em UTC e adianta 1 dia depois das 21h em SP.
    function icDiaSP(t) {
        if (t == null || t === '') return '';
        if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
        var d = t instanceof Date ? t : new Date(String(t).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
        if (isNaN(d.getTime())) return '';
        var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        return p;
    }
    // Instante (ISO com -03:00) que cai no dia ymd de São Paulo, com a hora do relógio de SP em "agora".
    // Gravar assim mantém o dia certo em qualquer fuso do navegador e depois de qualquer conversão para UTC.
    function icIsoNoDiaSP(ymd, agora) {
        var a = agora || new Date();
        var hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(a);
        return ymd + 'T' + hora + '-03:00';
    }

    var api = {
        icDiaSP: icDiaSP, icIsoNoDiaSP: icIsoNoDiaSP,
        icCpfDigitos: icCpfDigitos, icCpfMascara: icCpfMascara, icCpfValido: icCpfValido, icCpfNormalizar: icCpfNormalizar,
        icCpfFormatar: icCpfFormatar, icCpfMascararParaLog: icCpfMascararParaLog,
        icTelefoneParaE164: icTelefoneParaE164, icTelefoneFormatar: icTelefoneFormatar, icTelefoneMascara: icTelefoneMascara, icTelefoneErro: icTelefoneErro,
        icEmailNormalizar: icEmailNormalizar,
        IC_ORIGENS: IC_ORIGENS, icOrigemChave: icOrigemChave, icOrigemRotulo: icOrigemRotulo,
        icMoedaFormatar: icMoedaFormatar, icMoedaMascara: icMoedaMascara, icMoedaParaNumero: icMoedaParaNumero,
        icDataBR: icDataBR, icDataParaIso: icDataParaIso
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.keys(api).forEach(function (k) { raiz[k] = api[k]; });
})(typeof window !== 'undefined' ? window : this);
