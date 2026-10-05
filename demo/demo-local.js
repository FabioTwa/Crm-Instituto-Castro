// IC CRM — MODO DEMONSTRAÇÃO LOCAL. SOMENTE PARA TESTE.
//
// Substitui o Supabase por um Postgres de verdade rodando DENTRO do navegador
// (PGlite, WebAssembly). O banco executa os mesmos arquivos SQL do projeto
// (supabase/sql/00-20), então regras, funções e a permissão de dinheiro são as
// reais. Só a camada REST do Supabase (PostgREST) e o login são simulados aqui.
//
// Só liga quando as DUAS condições valem:
//   1. a página está em localhost / 127.0.0.1;
//   2. o config.js local define window.IC_CONFIG.DEMO_LOCAL = { ... }.
// Em produção o config.js não tem essa chave e o arquivo nem é publicado
// (.vercelignore). Dados e credenciais aqui são fictícios, de teste.
//
// Limites: sem RLS (o navegador roda como dono do banco), sem Edge Functions
// reais (envio de WhatsApp e Google ficam desligados), dados em memória (reset
// ao recarregar).
(function () {
    'use strict';
    var cfg = window.IC_CONFIG && window.IC_CONFIG.DEMO_LOCAL;
    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (!cfg || !local) return;

    var PGLITE_VER = '0.5.8';
    var CDN = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite@' + PGLITE_VER + '/dist/';
    var ARQUIVOS_SQL = ['00_extensoes', '01_funcoes_base', '02_tabelas', '03_encaixe_vendas', '04_chaves_estrangeiras', '05_indices', '06_funcoes', '07_views', '08_gatilhos', '09_rls_e_politicas', '10_realtime', '13_ic_perfis_e_parametros', '14_ic_permissao_dinheiro', '15_ic_rls', '16_ic_jobs', '17_ic_ia', '18_ic_agendamentos', '19_ic_reserva_vendas', '20_ic_apoio_front', '21_ic_funis', '22_ic_historico_realtime', '23_ic_cadastro_padrao', '24_ic_limites_de_texto', '25_ic_usuarios_auth', '26_ic_funcoes_sem_anon'];
    var SESSAO_KEY = 'ic_demo_session';

    // ---------- aviso visual de que é demo ----------
    function faixa(txt, erro) {
        var el = document.getElementById('ic-demo-faixa');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ic-demo-faixa';
            el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:6px 12px;font:600 12px Manrope,Inter,sans-serif;text-align:center;background:#0E0E25;color:#fff;letter-spacing:.3px';
            (document.body || document.documentElement).appendChild(el);
            if (!document.body) document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(el); });
        }
        el.style.background = erro ? '#C02B0A' : '#0E0E25';
        el.textContent = txt;
    }
    console.info('[demo-local] modo demonstração local ativo: dados fictícios, banco no navegador.');

    // ---------- banco ----------
    var pg = null, tipos = {};
    var ready = (async function () {
        var mod = await import(CDN + 'index.js');
        var trgm = await import(CDN + 'contrib/pg_trgm.js');
        // PostgREST devolve datas como texto ISO e números como JSON; o PGlite devolve Date/BigInt/string.
        var iso = function (v) { v = String(v).replace(' ', 'T'); return /[+-][0-9][0-9]$/.test(v) ? v + ':00' : v; };
        pg = new mod.PGlite({ extensions: { pg_trgm: trgm.pg_trgm }, parsers: { 1184: iso, 1114: function (v) { return String(v).replace(' ', 'T'); }, 20: function (v) { return Number(v); }, 1700: function (v) { return Number(v); } } });
        await pg.waitReady;
        async function texto(url) { var r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('Falha ao ler ' + url); return r.text(); }
        await pg.exec(await texto('demo/bootstrap.sql'));
        for (var i = 0; i < ARQUIVOS_SQL.length; i++) {
            try { await pg.exec(await texto('supabase/sql/' + ARQUIVOS_SQL[i] + '.sql')); }
            catch (e) { throw new Error(ARQUIVOS_SQL[i] + ': ' + e.message); }
        }
        var seed = await texto('demo/seed-demo.sql');
        var sub = { __ADMIN_EMAIL__: cfg.admin.email, __ADMIN_NOME__: cfg.admin.nome, __ATEND_EMAIL__: cfg.atendente.email, __ATEND_NOME__: cfg.atendente.nome };
        Object.keys(sub).forEach(function (k) { seed = seed.split(k).join(String(sub[k]).replace(/'/g, "''")); });
        await pg.exec(seed);
        var r = await pg.query("select table_name t, column_name c, data_type d from information_schema.columns where table_schema='public'");
        r.rows.forEach(function (x) { tipos[x.t + '.' + x.c] = x.d; });
        aplicarJwt();
        console.info('[demo-local] banco pronto.');
    })();
    ready.catch(function (e) { console.error('[demo-local]', e); faixa('Falha ao subir o banco de demonstração: ' + e.message, true); });

    function sessao() { try { return JSON.parse(localStorage.getItem(SESSAO_KEY) || 'null'); } catch (e) { return null; } }
    function aplicarJwt() {
        var s = sessao();
        if (pg) return pg.query("select set_config('app.jwt_email', $1, false)", [s ? s.user.email : '']);
    }

    // ---------- serialização de valores ----------
    function ident(n) { if (!/^[a-z_][a-z0-9_]*$/i.test(n)) throw new Error('identificador inválido: ' + n); return '"' + n + '"'; }
    function valor(tabela, col, v) {
        if (v === undefined) return null;
        if (v === null) return null;
        var t = tipos[tabela + '.' + col];
        if (t === 'jsonb' || t === 'json') return JSON.stringify(v);
        if (t === 'ARRAY' && Array.isArray(v)) return '{' + v.map(function (x) { return '"' + String(x).replace(/(["\\])/g, '\\$1') + '"'; }).join(',') + '}';
        if (v instanceof Date) return v.toISOString();
        return v;
    }
    function erro(e) { return { message: e && e.message || String(e), code: e && e.code, details: e && e.detail || null, hint: null }; }

    // ---------- query builder compatível com o uso do front ----------
    function QB(tabela) {
        this.t = tabela; this.op = 'select'; this.cols = '*'; this.where = []; this.orders = []; this.lim = null; this.off = null;
        this.contar = false; this.head = false; this.unico = null; this.payload = null; this.pedeRetorno = false; this.conflito = null;
    }
    QB.prototype.select = function (cols, opt) {
        if (this.op === 'select') this.cols = cols || '*'; else this.pedeRetorno = true;
        if (opt && opt.count) this.contar = true; if (opt && opt.head) this.head = true; return this;
    };
    QB.prototype.insert = function (p) { this.op = 'insert'; this.payload = p; return this; };
    QB.prototype.update = function (p) { this.op = 'update'; this.payload = p; return this; };
    QB.prototype.upsert = function (p, o) { this.op = 'upsert'; this.payload = p; this.conflito = o && o.onConflict; return this; };
    QB.prototype.delete = function () { this.op = 'delete'; return this; };
    ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is'].forEach(function (o) {
        QB.prototype[o] = function (c, v) { this.where.push({ k: 'op', o: o, c: c, v: v, neg: false }); return this; };
    });
    QB.prototype.in = function (c, v) { this.where.push({ k: 'in', c: c, v: v, neg: false }); return this; };
    QB.prototype.not = function (c, o, v) {
        if (o === 'in') this.where.push({ k: 'in', c: c, v: parseLista(v), neg: true });
        else this.where.push({ k: 'op', o: o, c: c, v: v, neg: true });
        return this;
    };
    QB.prototype.or = function (s) { this.where.push({ k: 'or', s: s }); return this; };
    QB.prototype.match = function (obj) { var self = this; Object.keys(obj).forEach(function (k) { self.eq(k, obj[k]); }); return this; };
    QB.prototype.filter = function (c, o, v) { this.where.push({ k: 'op', o: o, c: c, v: v, neg: false }); return this; };
    QB.prototype.order = function (c, o) { this.orders.push({ c: c, asc: !(o && o.ascending === false), nf: o && o.nullsFirst }); return this; };
    QB.prototype.limit = function (n) { this.lim = n; return this; };
    QB.prototype.range = function (a, b) { this.off = a; this.lim = b - a + 1; return this; };
    QB.prototype.single = function () { this.unico = 'single'; return this; };
    QB.prototype.maybeSingle = function () { this.unico = 'maybe'; return this; };
    QB.prototype.then = function (ok, ko) { return this.executar().then(ok, ko); };

    function parseLista(v) { return String(v).replace(/^\(|\)$/g, '').split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); }).filter(function (s) { return s !== ''; }); }

    function condOp(o, c, v, neg, params) {
        var col = ident(c), sql;
        if (o === 'is') {
            var lit = (v === null || String(v) === 'null') ? 'null' : (String(v) === 'true' ? 'true' : 'false');
            sql = col + ' is ' + lit;
        } else {
            var ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
            if (v === null && (o === 'eq')) sql = col + ' is null'; else {
                params.push(v); sql = col + ' ' + ops[o] + ' $' + params.length + (o === 'like' || o === 'ilike' ? '' : '');
            }
        }
        return neg ? 'not (' + sql + ')' : sql;
    }
    function condIn(c, arr, neg, params) {
        if (!arr.length) return neg ? 'true' : 'false';
        var ph = arr.map(function (x) { params.push(x); return '$' + params.length; });
        return ident(c) + (neg ? ' not in (' : ' in (') + ph.join(',') + ')';
    }
    function montarWhere(filtros, params) {
        var partes = [];
        filtros.forEach(function (f) {
            if (f.k === 'op') partes.push(condOp(f.o, f.c, f.v, f.neg, params));
            else if (f.k === 'in') partes.push(condIn(f.c, f.v, f.neg, params));
            else if (f.k === 'or') {
                var sub = f.s.split(',').map(function (p) {
                    var m = p.match(/^([a-z_0-9]+)\.([a-z]+)\.(.*)$/i);
                    if (!m) throw new Error('or() não suportado: ' + p);
                    var v = m[3];
                    if (m[2] === 'is') return condOp('is', m[1], v, false, params);
                    if (m[2] === 'in') return condIn(m[1], parseLista(v), false, params);
                    return condOp(m[2], m[1], v, false, params);
                });
                partes.push('(' + sub.join(' or ') + ')');
            }
        });
        return partes.length ? ' where ' + partes.join(' and ') : '';
    }

    QB.prototype.executar = async function () {
        await ready;
        await aplicarJwt();
        var self = this, params = [], t = ident(this.t), sql, rows = [], total = null;
        try {
            if (this.op === 'select') {
                var lista = this.cols.trim() === '*' ? '*' : this.cols.split(',').map(function (c) { return ident(c.trim().split(/[\s:(]/)[0]); }).join(', ');
                var w = montarWhere(this.where, params);
                if (this.contar) { var rc = await pg.query('select count(*)::int n from ' + t + w, params); total = rc.rows[0].n; }
                if (this.head) return { data: null, error: null, count: total };
                sql = 'select ' + lista + ' from ' + t + w;
                if (this.orders.length) sql += ' order by ' + this.orders.map(function (o) { return ident(o.c) + (o.asc ? ' asc' : ' desc') + (o.nf === true ? ' nulls first' : o.nf === false ? ' nulls last' : ''); }).join(', ');
                if (this.lim != null) sql += ' limit ' + parseInt(this.lim, 10);
                if (this.off) sql += ' offset ' + parseInt(this.off, 10);
                rows = (await pg.query(sql, params)).rows;
            } else if (this.op === 'insert' || this.op === 'upsert') {
                var lin = Array.isArray(this.payload) ? this.payload : [this.payload];
                if (!lin.length) return { data: [], error: null };
                var cs = []; lin.forEach(function (l) { Object.keys(l).forEach(function (k) { if (cs.indexOf(k) < 0) cs.push(k); }); });
                var vals = lin.map(function (l) {
                    return '(' + cs.map(function (c) { if (l[c] === undefined) return 'default'; params.push(valor(self.t, c, l[c])); return '$' + params.length; }).join(',') + ')';
                });
                sql = 'insert into ' + t + ' (' + cs.map(ident).join(',') + ') values ' + vals.join(',');
                if (this.op === 'upsert') {
                    var alvo = (this.conflito || 'id').split(',').map(function (x) { return ident(x.trim()); }).join(',');
                    var sets = cs.filter(function (c) { return (self.conflito || 'id').split(',').map(function (x) { return x.trim(); }).indexOf(c) < 0; }).map(function (c) { return ident(c) + ' = excluded.' + ident(c); });
                    sql += ' on conflict (' + alvo + ') ' + (sets.length ? 'do update set ' + sets.join(', ') : 'do nothing');
                }
                sql += ' returning *';
                rows = (await pg.query(sql, params)).rows;
            } else if (this.op === 'update') {
                var ks = Object.keys(this.payload), sets2 = ks.map(function (k) { params.push(valor(self.t, k, self.payload[k])); return ident(k) + ' = $' + params.length; });
                sql = 'update ' + t + ' set ' + sets2.join(', ') + montarWhere(this.where, params) + ' returning *';
                rows = (await pg.query(sql, params)).rows;
            } else if (this.op === 'delete') {
                sql = 'delete from ' + t + montarWhere(this.where, params) + ' returning *';
                rows = (await pg.query(sql, params)).rows;
            }
        } catch (e) { console.warn('[demo-local] erro SQL em ' + this.t + ':', e.message); return { data: null, error: erro(e), count: null }; }

        var escreveu = this.op !== 'select';
        if (escreveu && !this.pedeRetorno) return { data: null, error: null, count: null };
        if (this.unico) {
            if (rows.length === 1) return { data: rows[0], error: null, count: total };
            if (rows.length === 0 && this.unico === 'maybe') return { data: null, error: null, count: total };
            return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains ' + rows.length + ' rows' }, count: total };
        }
        return { data: rows, error: null, count: total };
    };

    // ---------- rpc ----------
    async function rpc(nome, args) {
        await ready; await aplicarJwt();
        try {
            var chaves = Object.keys(args || {}), params = [];
            var lista = chaves.map(function (k) {
                var v = args[k]; if (v !== null && typeof v === 'object' && !Array.isArray(v)) v = JSON.stringify(v);
                params.push(v === undefined ? null : v); return ident(k) + ' => $' + params.length;
            });
            var r = await pg.query('select * from public.' + ident(nome) + '(' + lista.join(', ') + ')', params);
            var campos = r.fields.map(function (f) { return f.name; });
            if (campos.length === 1 && campos[0] === nome) return { data: r.rows[0] ? r.rows[0][nome] : null, error: null };
            return { data: r.rows, error: null };
        } catch (e) { console.warn('[demo-local] erro em rpc ' + nome + ':', e.message); return { data: null, error: erro(e) }; }
    }

    // ---------- auth ----------
    function usuarioPorEmail(email) {
        var e = String(email || '').trim().toLowerCase();
        if (cfg.admin && e === cfg.admin.email.toLowerCase()) return { cred: cfg.admin };
        if (cfg.atendente && e === cfg.atendente.email.toLowerCase()) return { cred: cfg.atendente };
        return null;
    }
    var auth = {
        signInWithPassword: async function (o) {
            var u = usuarioPorEmail(o && o.email);
            if (!u || String(o.password) !== u.cred.senha) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials', status: 400 } };
            var user = { id: 'demo-auth-' + u.cred.email, email: u.cred.email, aud: 'authenticated', role: 'authenticated', user_metadata: { name: u.cred.nome } };
            var s = { access_token: 'demo-local-token', refresh_token: 'demo', expires_in: 3600, token_type: 'bearer', user: user };
            localStorage.setItem(SESSAO_KEY, JSON.stringify(s));
            await ready; await aplicarJwt();
            return { data: { user: user, session: s }, error: null };
        },
        getSession: async function () { var s = sessao(); if (s) { await ready; await aplicarJwt(); } return { data: { session: s }, error: null }; },
        getUser: async function () { var s = sessao(); return { data: { user: s ? s.user : null }, error: null }; },
        signOut: async function () { localStorage.removeItem(SESSAO_KEY); await aplicarJwt(); return { error: null }; },
        updateUser: async function () { return { data: {}, error: null }; },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
        signUp: async function () { return { data: null, error: { message: 'Cadastro desligado no modo demonstração.' } }; }
    };

    // ---------- Edge Functions simuladas ----------
    var functions = {
        invoke: async function (nome, opt) {
            var b = (opt && opt.body) || {};
            if (nome === 'ic-whatsapp-send') return { data: { ok: false, erro: 'envio_desligado' }, error: null };
            if (nome === 'ic-usuarios' && b.acao === 'criar') {
                // Sem Supabase Auth na demonstração: só a linha em users (o login de teste continua sendo o do config.js).
                var email = String(b.email || '').trim().toLowerCase();
                var dup = await new QB('users').select('id').eq('email', email).maybeSingle();
                if (dup.data) return { data: { ok: false, erro: 'email_ja_cadastrado' }, error: null };
                var ins = await new QB('users').insert({
                    name: String(b.name || '').trim(), email: email, pw: 'supabase_auth',
                    role: String(b.perfil || '').toUpperCase() === 'ADMIN' ? 'admin' : 'operador',
                    perfil: b.perfil, perfil_id: b.perfil_id || null, status: 'ativo',
                    vendedor_responsavel_id: b.vendedor_responsavel_id || null,
                    vendedor_responsavel_nome: b.vendedor_responsavel_nome || null,
                    vendedores_responsaveis_ids: b.vendedores_responsaveis_ids || null,
                    telas_permitidas: b.telas_permitidas || null
                }).select('id').single();
                if (ins.error) return { data: null, error: ins.error };
                return { data: { ok: true, id: ins.data.id }, error: null };
            }
            if (nome === 'ic-agendamento') {
                if (b.acao === 'criar') {
                    var r = await rpc('ic_agendamento_criar', { p_cliente: b.cliente_crm_id, p_inicio: b.inicio, p_fim: b.fim, p_responsavel: b.responsavel_id, p_titulo: b.titulo, p_tipo: b.tipo || 'consulta', p_obs: b.observacoes || null });
                    if (r.error) return { data: null, error: r.error };
                    return { data: { ok: true, google_sync_status: 'desligado' }, error: null };
                }
                if (b.acao === 'status') {
                    var r2 = await rpc('ic_agendamento_status', { p_id: b.id, p_status: b.status });
                    if (r2.error) return { data: null, error: r2.error };
                    return { data: { ok: true, status: b.status, google_sync_status: 'desligado' }, error: null };
                }
                if (b.acao === 'google_oauth_url') return { data: null, error: { message: 'Google Agenda indisponível no modo demonstração.' } };
                return { data: { ok: true }, error: null };
            }
            return { data: null, error: { message: 'Função ' + nome + ' indisponível no modo demonstração.' } };
        }
    };

    // ---------- realtime (sem eventos: a tela só recarrega ao navegar) ----------
    function canal() {
        var c = { on: function () { return c; }, subscribe: function (cb) { if (cb) setTimeout(function () { cb('SUBSCRIBED'); }, 0); return c; }, unsubscribe: function () {} };
        return c;
    }

    var cliente = {
        from: function (t) { return new QB(t); },
        rpc: function (n, a) { return Promise.resolve(rpc(n, a)); },
        auth: auth, functions: functions,
        channel: canal, removeChannel: function () { return Promise.resolve('ok'); }
    };
    window.supabase = window.supabase || {};
    window.supabase.createClient = function () { return cliente; };
    window.__icDemoLocal = { ready: ready, query: function (s, p) { return ready.then(function () { return pg.query(s, p); }); } };
})();
