// E2E da barra de navegação do celular e do menu do computador (Playwright, Chromium).
//
// Roda o sistema no MODO DEMONSTRAÇÃO LOCAL (demo/demo-local.js): banco Postgres no navegador,
// dados fictícios, sem Supabase e sem rede. Nada aqui vai para o site publicado.
//
// Preparação (uma vez, numa pasta fora do repositório):
//   mkdir vendor && cd vendor && npm init -y
//   npm i playwright @electric-sql/pglite@0.5.8 @supabase/supabase-js@2.117.2 lucide@1.52.0
// Execução (na raiz do repositório):
//   IC_E2E_VENDOR=/caminho/vendor node teste/e2e-barra-celular.mjs celular
//   IC_E2E_VENDOR=/caminho/vendor node teste/e2e-barra-celular.mjs computador
//   IC_E2E_PRINTS=/pasta  (opcional) grava os prints usados na descrição do PR.
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
const PRINTS = process.env.IC_E2E_PRINTS || '';
const MODO = process.argv[2];
if (!VENDOR || !['celular', 'computador'].includes(MODO)) {
    console.log('uso: IC_E2E_VENDOR=<pasta> node teste/e2e-barra-celular.mjs celular|computador');
    process.exit(2);
}
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
//   computador (>= 1024px): o menu lateral já fica aberto; devolve o <nav> dele.
//   celular/tablet: toca no "Mais" da barra e devolve a folha (role=dialog).
async function abrirMenu(page) {
    const largura = page.viewportSize().width;
    if (largura >= 1024) return page.locator('#ic-menu-lateral');
    if (!(await page.locator('#ic-mais-folha').count())) await page.click('#ic-barra-mais');
    await page.waitForSelector('#ic-mais-folha');
    return page.locator('#ic-mais-folha');
}
// Vai a uma tela pelo menu do tamanho atual (barra, folha "Mais" ou menu lateral).
async function irPara(page, rotulo) {
    const largura = page.viewportSize().width;
    if (largura < 1024) {
        const naBarra = page.locator('#ic-barra-lista .ic-barra-item', { hasText: rotulo });
        if (await naBarra.count()) { await naBarra.first().click(); return; }
    }
    const menu = await abrirMenu(page);
    await menu.locator(largura >= 1024 ? '.sidebar-item' : '.ic-mais-item', { hasText: rotulo }).first().click();
}

const MARCA = 'rgb(45, 98, 152)';     // --ic-secondary
const CINZA = 'rgb(114, 117, 134)';   // --ic-muted

const rotulosBarra = (page) => page.$$eval('#ic-barra-lista .ic-barra-item', (bs) => bs.map((b) => b.textContent.trim()));
const rotulosMais = (page) => page.$$eval('#ic-mais-folha .ic-mais-item', (bs) => bs.map((b) => b.textContent.trim()));
const visivel = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; }).catch(() => false);

async function print(page, nome) {
    if (!PRINTS) return;
    fs.mkdirSync(PRINTS, { recursive: true });
    await page.screenshot({ path: path.join(PRINTS, nome + '.png') });
}

async function testarComputador(browser, base) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: PRINTS ? 2 : 1 });
    await rotear(ctx);
    const page = await ctx.newPage();
    await entrar(page, base, 'admin');
    check('barra de baixo não aparece', !(await visivel(page, '#ic-barra')));
    check('topo do celular não aparece', !(await visivel(page, '.ic-topbar')));
    check('menu lateral aparece', await visivel(page, '#ic-sidebar'));
    const lateral = await page.$$eval('#ic-menu-lateral .sidebar-item', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
    check('menu lateral com os itens de sempre, na ordem de sempre', JSON.stringify(lateral) === JSON.stringify(['Leads', 'Ações do Dia', 'CRM / Pipeline', 'Agendamentos', 'WhatsApp', 'Usuários', 'Permissões', 'Redistribuir Leads', 'Histórico de Alterações', 'Meu Perfil']), lateral);
    check('pipeline marcado no menu lateral', await page.$eval('#nav-crm', (b) => b.classList.contains('active')));
    check('conteúdo sem folga da barra no computador', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ic-barra-h').trim() === '0px'));
    await irPara(page, 'Usuários');
    await page.waitForSelector('#view-usuarios.active');
    check('menu lateral leva à tela', await page.$eval('#nav-usuarios', (b) => b.classList.contains('active')));
    await irPara(page, 'CRM / Pipeline');
    await page.waitForSelector('#view-crm.active');
    await page.waitForTimeout(400);
    await print(page, 'computador-sem-mudanca');

    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await rotear(ctx2);
    const p2 = await ctx2.newPage();
    await entrar(p2, base, 'atendente');
    const lat2 = await p2.$$eval('#ic-menu-lateral .sidebar-item', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
    check('atendente vê menos itens no menu lateral', JSON.stringify(lat2) === JSON.stringify(['Ações do Dia', 'CRM / Pipeline', 'Agendamentos', 'Meu Perfil']), lat2);
    await ctx.close(); await ctx2.close();
}

async function testarCelular(browser, base) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: PRINTS ? 2 : 1, hasTouch: true, isMobile: true });
    await rotear(ctx);
    const page = await ctx.newPage();
    await entrar(page, base, 'admin');

    // ---- barra
    check('menu lateral não aparece', !(await visivel(page, '#ic-sidebar')));
    check('botão antigo do topo saiu', (await page.locator('.mobile-menu-btn').count()) === 0);
    check('topo só com o logo', await page.$eval('.ic-topbar', (t) => t.querySelectorAll('button').length === 0 && !!t.querySelector('img')));
    const itens = await rotulosBarra(page);
    check('itens certos na ordem certa', JSON.stringify(itens) === JSON.stringify(['Pipeline', 'Leads', 'Ações do Dia', 'Agendamentos', 'Mais']), itens);
    const geo = await page.evaluate(() => {
        const r = document.getElementById('ic-barra').getBoundingClientRect();
        const lista = document.getElementById('ic-barra-lista').getBoundingClientRect();
        const toques = [...document.querySelectorAll('#ic-barra-lista .ic-barra-item')].map((b) => { const x = b.getBoundingClientRect(); return [Math.round(x.width), Math.round(x.height)]; });
        return { bottom: r.bottom, left: r.left, width: r.width, util: lista.height, ih: innerHeight, iw: innerWidth, sw: document.documentElement.scrollWidth, toques,
            nav: document.getElementById('ic-barra').tagName, nome: document.getElementById('ic-barra').getAttribute('aria-label'),
            lateral: document.getElementById('ic-menu-lateral').getAttribute('aria-label'), emLista: !!document.querySelector('#ic-barra ul > li > .ic-barra-item') };
    });
    check('barra encosta no fim da janela', Math.abs(geo.bottom - geo.ih) < 1, geo);
    check('barra ocupa a largura toda', geo.left === 0 && Math.abs(geo.width - geo.iw) < 1, geo);
    check('altura útil de 64px', Math.round(geo.util) === 64, geo);
    check('página não rola de lado', geo.sw <= geo.iw, geo);
    check('cada toque tem pelo menos 44 x 44', geo.toques.every(([w, h]) => w >= 44 && h >= 44), geo.toques);
    check('barra é um <nav> com nome próprio, diferente do menu lateral', geo.nav === 'NAV' && geo.nome === 'Menu do celular' && geo.lateral !== geo.nome, geo);
    check('itens da barra numa lista', geo.emLista);

    // ---- tela aberta na cor da marca
    const cores = await page.$$eval('#ic-barra-lista .ic-barra-item', (bs) => bs.map((b) => ({ t: b.textContent.trim(), cor: getComputedStyle(b).color, atual: b.getAttribute('aria-current'), peso: getComputedStyle(b).fontWeight })));
    const pip = cores.find((c) => c.t === 'Pipeline');
    check('tela aberta na cor da marca com aria-current=page', pip.cor === MARCA && pip.atual === 'page' && Number(pip.peso) >= 600, pip);
    check('as outras ficam no cinza, sem aria-current', cores.filter((c) => c.t !== 'Pipeline').every((c) => c.cor === CINZA && c.atual === null), cores);
    await print(page, 'celular-barra-pipeline');

    // ---- o que fica preso embaixo sobe a altura da barra
    const presos = await page.evaluate(() => {
        const topo = document.getElementById('ic-barra').getBoundingClientRect().top;
        return [...document.querySelectorAll('.crm-fila.visivel, .toast-container')].map((e) => ({ c: e.className, bottom: e.getBoundingClientRect().bottom, topo }))
            .filter((x) => x.bottom > 0);
    });
    check('avisos presos embaixo ficam acima da barra', presos.every((x) => x.bottom <= x.topo + 0.5), presos);
    await page.evaluate(() => showToast('Aviso de teste', 'success'));
    const toast = await page.evaluate(() => { const t = document.querySelector('.toast-container .toast, .toast-container > *'); return t ? [t.getBoundingClientRect().bottom, document.getElementById('ic-barra').getBoundingClientRect().top] : null; });
    check('aviso (toast) aparece acima da barra', !!toast && toast[0] <= toast[1] + 0.5, toast);

    // ---- rolando até o fim, o conteúdo termina acima da barra
    for (const rotulo of ['Pipeline', 'Ações do Dia', 'Leads']) {
        await irPara(page, rotulo);
        await page.waitForTimeout(900);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(200);
        const fim = await page.evaluate(() => {
            const view = document.querySelector('.main-content .view.active');
            const topo = document.getElementById('ic-barra').getBoundingClientRect().top;
            let max = view.getBoundingClientRect().bottom;
            view.querySelectorAll('*').forEach((e) => {
                const cs = getComputedStyle(e);
                if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
                const r = e.getBoundingClientRect();
                if (r.width && r.height) max = Math.max(max, r.bottom);
            });
            return { max: Math.round(max), topo: Math.round(topo) };
        });
        check('rolando até o fim, o último elemento termina acima da barra (' + rotulo + ')', fim.max <= fim.topo, fim);
    }
    await irPara(page, 'Pipeline');
    await page.waitForSelector('#view-crm.active');
    await page.evaluate(() => window.scrollTo(0, 0));

    // ---- folha "Mais"
    let folha = await abrirMenu(page);
    await page.waitForTimeout(250);   // fim da animação de subida (160ms) antes de medir
    const aria = await page.evaluate(() => {
        const f = document.getElementById('ic-mais-folha'), m = document.getElementById('ic-barra-mais');
        return { role: f.getAttribute('role'), modal: f.getAttribute('aria-modal'), nome: f.getAttribute('aria-label'),
            tag: m.tagName, pop: m.getAttribute('aria-haspopup'), exp: m.getAttribute('aria-expanded'), ctl: m.getAttribute('aria-controls'),
            foco: document.activeElement && document.activeElement.textContent.trim(),
            alturas: [...f.querySelectorAll('.ic-mais-item')].map((b) => Math.round(b.getBoundingClientRect().height)),
            folhaBottom: f.getBoundingClientRect().bottom, barraTop: document.getElementById('ic-barra').getBoundingClientRect().top,
            raio: getComputedStyle(f).borderTopLeftRadius,
            barraPorCima: document.elementFromPoint(innerWidth / 2, innerHeight - 20).closest('#ic-barra') !== null };
    });
    check('"Mais" é <button> com aria-haspopup=dialog, aria-expanded e aria-controls', aria.tag === 'BUTTON' && aria.pop === 'dialog' && aria.exp === 'true' && aria.ctl === 'ic-mais-folha', aria);
    check('folha com role=dialog, aria-modal e nome', aria.role === 'dialog' && aria.modal === 'true' && aria.nome === 'Mais opções', aria);
    check('ao abrir, o foco vai para o primeiro item', aria.foco === 'WhatsApp', aria.foco);
    check('itens da folha com 48px', aria.alturas.every((h) => h >= 48), aria.alturas);
    check('folha logo acima da barra, cantos de 16px', Math.abs(aria.folhaBottom - aria.barraTop) < 1.5 && aria.raio === '16px', aria);
    check('barra continua visível por cima do fundo escuro', aria.barraPorCima);
    const mais = await rotulosMais(page);
    check('"Mais" com o resto do menu, perfil e Sair, na ordem do computador', JSON.stringify(mais) === JSON.stringify(['WhatsApp', 'Usuários', 'Permissões', 'Redistribuir Leads', 'Histórico de Alterações', 'Meu Perfil', 'Sair']), mais);
    await print(page, 'celular-folha-mais');

    // foco preso dentro da folha
    for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
    const dentro1 = await page.evaluate(() => !!document.activeElement.closest('#ic-mais-folha'));
    await page.keyboard.press('Shift+Tab');
    await page.evaluate(() => document.querySelector('#ic-mais-folha .ic-mais-item').focus());
    await page.keyboard.press('Shift+Tab');
    const ultimo = await page.evaluate(() => document.activeElement.textContent.trim());
    check('Tab e Shift+Tab ficam dentro da folha', dentro1 && ultimo === 'Sair', { dentro1, ultimo });

    // página de trás não rola
    const y0 = await page.evaluate(() => scrollY);
    await page.mouse.move(187, 150);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
    check('com a folha aberta a página de trás não rola', (await page.evaluate(() => scrollY)) === y0 && await page.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden'));

    // Esc fecha e devolve o foco
    await page.keyboard.press('Escape');
    const esc = await page.evaluate(() => ({ some: !document.getElementById('ic-mais-folha') && !document.querySelector('.ic-mais-overlay'), foco: document.activeElement && document.activeElement.id, exp: document.getElementById('ic-barra-mais').getAttribute('aria-expanded') }));
    check('Esc fecha, a folha some do HTML e o foco volta para o "Mais"', esc.some && esc.foco === 'ic-barra-mais' && esc.exp === 'false', esc);

    // toque no fundo fecha
    await abrirMenu(page);
    await page.mouse.click(187, 120);
    check('toque no fundo fecha', (await page.locator('#ic-mais-folha').count()) === 0);

    // tocar no "Mais" de novo fecha
    await abrirMenu(page);
    await page.click('#ic-barra-mais');
    check('tocar no "Mais" de novo fecha', (await page.locator('#ic-mais-folha').count()) === 0);

    // item leva à tela e fecha; "Mais" fica na cor da marca
    folha = await abrirMenu(page);
    await folha.locator('.ic-mais-item', { hasText: 'Usuários' }).click();
    await page.waitForSelector('#view-usuarios.active');
    const st = await page.evaluate(() => ({ fechada: !document.getElementById('ic-mais-folha'), mais: getComputedStyle(document.getElementById('ic-barra-mais')).color,
        pip: getComputedStyle(document.querySelector('[data-menu-id="crm"]')).color }));
    check('item leva à tela e fecha a folha', st.fechada, st);
    check('"Mais" na cor da marca quando a tela aberta está dentro dele', st.mais === MARCA && st.pip === CINZA, st);
    await print(page, 'celular-mais-ativo-usuarios');
    folha = await abrirMenu(page);
    check('na folha, a tela aberta tem aria-current=page', await page.$eval('#ic-mais-folha [data-menu-id="usuarios"]', (b) => b.getAttribute('aria-current') === 'page'));
    await page.keyboard.press('Escape');

    // botão voltar fecha
    await abrirMenu(page);
    await page.goBack();
    await page.waitForTimeout(400);
    check('botão voltar fecha a folha', (await page.locator('#ic-mais-folha').count()) === 0);

    // item da barra: troca a cor
    await irPara(page, 'Ações do Dia');
    await page.waitForSelector('#view-acoes-dia.active');
    const acoes = await page.$eval('[data-menu-id="acoes-dia"]', (b) => [getComputedStyle(b).color, b.getAttribute('aria-current')]);
    check('item da barra acende ao abrir a tela', acoes[0] === MARCA && acoes[1] === 'page', acoes);
    await page.evaluate(() => window.scrollTo(0, 0));
    await print(page, 'celular-item-ativo-acoes');

    // tela larga fecha a folha
    await abrirMenu(page);
    await page.setViewportSize({ width: 1100, height: 812 });
    await page.waitForTimeout(200);
    check('tela larga fecha a folha e esconde a barra', (await page.locator('#ic-mais-folha').count()) === 0 && !(await visivel(page, '#ic-barra')));
    await page.setViewportSize({ width: 375, height: 812 });

    // tablet em pé (768) também usa a barra
    await page.setViewportSize({ width: 768, height: 1024 });
    check('tablet (768px) usa a barra e não o menu lateral', (await visivel(page, '#ic-barra')) && !(await visivel(page, '#ic-sidebar')));
    await page.setViewportSize({ width: 1023, height: 768 });
    check('1023px ainda usa a barra', await visivel(page, '#ic-barra'));
    await page.setViewportSize({ width: 375, height: 812 });

    // animação desligada com prefers-reduced-motion
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirMenu(page);
    check('sem animação com prefers-reduced-motion', await page.$eval('#ic-mais-folha', (f) => getComputedStyle(f).animationName === 'none'));
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await abrirMenu(page);
    check('com animação curta (160ms) no padrão', await page.$eval('#ic-mais-folha', (f) => getComputedStyle(f).animationDuration === '0.16s'));
    await page.keyboard.press('Escape');

    // Sair pela folha
    folha = await abrirMenu(page);
    await folha.locator('.ic-mais-item', { hasText: 'Sair' }).click();
    await page.waitForSelector('#view-login.active', { timeout: 15000 });
    check('"Sair" na folha encerra a sessão', !(await visivel(page, '#ic-barra')));
    await ctx.close();

    // ---- pessoa com menos acesso vê menos itens
    const ctx2 = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    await rotear(ctx2);
    const p2 = await ctx2.newPage();
    await entrar(p2, base, 'atendente');
    const b2 = await rotulosBarra(p2);
    check('atendente: barra sem Leads (sem buraco)', JSON.stringify(b2) === JSON.stringify(['Pipeline', 'Ações do Dia', 'Agendamentos', 'Mais']), b2);
    const larguras = await p2.$$eval('#ic-barra-lista > li', (ls) => ls.map((l) => Math.round(l.getBoundingClientRect().width)));
    check('posições de largura igual', new Set(larguras).size === 1, larguras);
    await abrirMenu(p2);
    const m2 = await rotulosMais(p2);
    check('atendente: "Mais" só com Meu Perfil e Sair', JSON.stringify(m2) === JSON.stringify(['Meu Perfil', 'Sair']), m2);
    await ctx2.close();
}

const srv = await servir();
const base = 'http://127.0.0.1:' + srv.address().port;
const browser = await chromium.launch();
try {
    if (MODO === 'computador') await testarComputador(browser, base);
    else await testarCelular(browser, base);
} catch (e) {
    falhas++;
    console.log('FALHOU [' + MODO + '] erro inesperado: ' + (e && e.stack || e));
} finally {
    await browser.close();
    srv.close();
}
console.log('\n[' + MODO + '] ' + (total - falhas) + ' de ' + total + ' verificações passaram' + (falhas ? ' (' + falhas + ' falha(s))' : ''));
process.exit(falhas ? 1 : 0);
