// E2E do "CRM travado ao abrir": carga do pipeline com prazo, sem corrida (Playwright, Chromium).
//
// Roda o sistema no MODO DEMONSTRAÇÃO LOCAL (demo/demo-local.js): banco Postgres no navegador,
// dados fictícios, sem Supabase e sem rede. Nada aqui vai para o site publicado.
//
// Preparação (uma vez, numa pasta fora do repositório):
//   mkdir vendor && cd vendor && npm init -y
//   npm i playwright @electric-sql/pglite@0.5.8 @supabase/supabase-js@2.117.2 lucide@1.52.0
// Execução (na raiz do repositório):
//   IC_E2E_VENDOR=/caminho/vendor node teste/testar-crm-travado.mjs
//
// As bibliotecas que o index.html busca em CDN (supabase-js, lucide, pglite) são servidas a partir
// do IC_E2E_VENDOR, nas MESMAS versões fixadas no index.html e no demo-local.js. O config.js é
// gerado só na memória do teste (com DEMO_LOCAL e credenciais fictícias); o arquivo nunca é criado.
// Sai com código 1 se qualquer verificação falhar.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = process.env.IC_E2E_VENDOR;
const MODO = 'pipeline';
if (!VENDOR) { console.log('uso: IC_E2E_VENDOR=<pasta> node teste/testar-crm-travado.mjs'); process.exit(2); }
const require = createRequire(path.join(VENDOR, 'package.json'));
const { chromium } = require('playwright');
const NM = path.join(VENDOR, 'node_modules');
const DEMO = {
    admin: { nome: 'Admin Teste', email: 'admin@exemplo.invalid', senha: 'senha-de-teste-admin' },
    atendente: { nome: 'Atendente Teste', email: 'atendente@exemplo.invalid', senha: 'senha-de-teste-atendente' }
};
const CONFIG_JS = 'window.IC_CONFIG = { SUPABASE_URL: "https://demo-local.supabase.co", SUPABASE_ANON_KEY: "demo", DEMO_LOCAL: '
    + JSON.stringify(DEMO) + ' };\nif (window.IC_CONFIG.DEMO_LOCAL) document.write(\'<script src="demo/demo-local.js"><\\/script>\');\n';

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.sql': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.gz': 'application/gzip' };

// ---------- servidor estático local ----------
function servir() {
    return new Promise((ok) => {
        const srv = http.createServer((req, res) => {
            let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
            if (p === '/') p = '/index.html';
            if (p === '/config.js') { res.writeHead(200, { 'content-type': TIPOS['.js'] }); return res.end(CONFIG_JS); }
            const arq = path.join(RAIZ, path.normalize(p));
            if (!arq.startsWith(RAIZ) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
            fs.createReadStream(arq).pipe(res);
        });
        srv.listen(0, '127.0.0.1', () => ok(srv));
    });
}

// CDN -> pasta vendor (mesmas versões)
const CDN = [
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.117\.2\/(.*)$/, path.join(NM, '@supabase', 'supabase-js')],
    [/^https:\/\/unpkg\.com\/lucide@1\.52\.0\/(.*)$/, path.join(NM, 'lucide')],
    [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@electric-sql\/pglite@0\.5\.8\/(.*)$/, path.join(NM, '@electric-sql', 'pglite')]
];
async function rotear(context) {
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
        const url = route.request().url().split('?')[0];
        for (const [re, base] of CDN) {
            const m = re.exec(url);
            if (m) {
                const arq = path.join(base, m[1]);
                if (fs.existsSync(arq)) return route.fulfill({ status: 200, path: arq, headers: { 'content-type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
                return route.fulfill({ status: 404, body: '' });
            }
        }
        // xlsx (só usado em exportar planilha), fontes e qualquer outro host: fora do teste.
        if (/\.js$/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        return route.abort();
    });
}

// ---------- verificações ----------
let falhas = 0, total = 0;
function check(nome, cond, extra) {
    total++;
    if (!cond) falhas++;
    console.log((cond ? 'ok     ' : 'FALHOU ') + '[' + MODO + '] ' + nome + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

async function entrar(page, base, quem) {
    await page.goto(base + '/');
    await page.waitForFunction(() => document.getElementById('view-login') && document.getElementById('login-email'), null, { timeout: 60000 });
    await page.fill('#login-email', DEMO[quem].email);
    await page.fill('#login-senha', DEMO[quem].senha);
    await page.click('#btn-login');
    await page.waitForFunction(() => document.getElementById('app-authenticated').style.display === 'flex'
        && document.querySelector('#view-crm.active, #view-leads.active, #view-acoes-dia.active'), null, { timeout: 90000 });
    await page.waitForTimeout(500);
}

// Ajudante único: abre "o menu" certo para o tamanho da tela.

// Faz as próximas consultas a uma tabela nunca voltarem (simula a requisição presa
// quando a aba acorda de segundo plano). vezes = quantas consultas prender.
async function prender(page, tabela, vezes) {
    await page.evaluate(([tabela, vezes]) => {
        if (!window._icFromOriginal) window._icFromOriginal = supabaseClient.from.bind(supabaseClient);
        window._icPresas = window._icPresas || {};
        window._icPresas[tabela] = vezes;
        supabaseClient.from = function (t) {
            if (window._icPresas[t] > 0) {
                window._icPresas[t]--;
                const presa = new Proxy(function () {}, {
                    get(_, k) { return k === 'then' ? function () {} : function () { return presa; }; },
                    apply() { return presa; }
                });
                return presa;
            }
            return window._icFromOriginal(t);
        };
    }, [tabela, vezes]);
}
const temKanban = (page) => page.evaluate(() => !!document.querySelector('#crm-pipeline-content .crm-col-body'));
const temSpinner = (page) => page.evaluate(() => !!document.querySelector('#crm-pipeline-content .loading-spinner'));
const temErro = (page) => page.evaluate(() => /Erro ao carregar CRM/.test(document.getElementById('crm-pipeline-content').textContent));

async function main() {
    const srv = await servir();
    const base = 'http://127.0.0.1:' + srv.address().port;
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await rotear(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    await entrar(page, base, 'admin');
    await page.waitForFunction(() => document.querySelector('#crm-pipeline-content .crm-col-body'), null, { timeout: 60000 });
    check('pipeline abre normalmente', await temKanban(page));
    // Prazo curto só no teste (em produção: 25 s).
    await page.evaluate(() => { IC_PRAZO_CRM = 1500; });

    // 1) Uma consulta presa: tenta de novo sozinho e abre o Kanban.
    await prender(page, 'crm_funil_etapas', 1);
    await page.evaluate(() => { loadCRM(); });
    await page.waitForTimeout(300);
    check('com consulta presa mostra o carregando', await temSpinner(page));
    await page.waitForTimeout(4000);
    check('depois do prazo tenta de novo e abre o Kanban', await temKanban(page) && !(await temSpinner(page)));

    // 2) Presa duas vezes: mostra erro com botão, nunca spinner eterno.
    await prender(page, 'crm_funil_etapas', 2);
    await page.evaluate(() => { loadCRM(); });
    await page.waitForTimeout(4500);
    check('presa de novo na tentativa: mostra erro com botão', await temErro(page) && !(await temSpinner(page)));
    await page.click('#crm-pipeline-content button');
    await page.waitForFunction(() => document.querySelector('#crm-pipeline-content .crm-col-body'), null, { timeout: 15000 }).catch(() => {});
    check('botão "Tentar novamente" abre o Kanban', await temKanban(page));

    // 3) Recarga de fundo (reconexão do tempo real) presa: o Kanban continua na tela.
    await prender(page, 'crm_funil_etapas', 5);
    await page.evaluate(() => { loadCRM({ silencioso: true }); });
    await page.waitForTimeout(300);
    check('recarga de fundo não apaga o Kanban', await temKanban(page) && !(await temSpinner(page)));
    await page.waitForTimeout(2500);
    check('recarga de fundo presa: Kanban continua, sem erro', await temKanban(page) && !(await temErro(page)));
    await page.evaluate(() => { window._icPresas = {}; });

    // 4) Duas cargas ao mesmo tempo, a primeira presa: a segunda manda na tela.
    await prender(page, 'crm_funil_etapas', 1);
    await page.evaluate(() => { loadCRM(); loadCRM(); });
    await page.waitForTimeout(4000);
    check('carga presa antiga não deixa spinner por cima', await temKanban(page) && !(await temSpinner(page)) && !(await temErro(page)));

    await browser.close();
    srv.close();
    console.log('\n' + (total - falhas) + ' de ' + total + ' verificações passaram');
    process.exit(falhas ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
