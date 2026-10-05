// Ferramenta de tema do IC CRM (Instituto Castro): mantém o index.html fiel aos tokens de identidade
// (--ic-*) e reprova a execução se alguma regra visual quebrar. Determinística e idempotente.
//
//   node ferramentas/aplicar-tema-ic.mjs index.html --reparar    reinstala o :root e o bloco de ferramentas/tema-ic.css,
//                                                                normaliza rgba/overlays/z-index e corrige fundos de superfície
//   node ferramentas/aplicar-tema-ic.mjs index.html --verificar  só roda as verificações (não grava)
//
// O que é verificado (qualquer falha aborta SEM gravar):
//   - nenhum token --ic-* referencia a si mesmo (o CSS trata como inválido e o fundo fica transparente);
//   - tokens com alpha (--ic-border, --ic-border-strong, --ic-overlay) nunca são fundo de superfície,
//     exceto em overlay e divisor;
//   - overlays usam --ic-overlay;
//   - nenhum z-index global (>= 50) literal: tudo passa pela escala --z-*;
//   - sidebar e conteúdo usam os mesmos tokens de largura e gutter;
//   - as superfícies (modal, painel, popover, toast...) têm fundo opaco.
// Ordem do --reparar: :root dos tokens, bloco do tema, normalização de rgba/overlays e z-index,
// correção de superfícies, verificações.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const arquivo = process.argv[2] || 'index.html';
const modo = process.argv.includes('--reparar') ? 'reparar' : process.argv.includes('--verificar') ? 'verificar' : null;
if (!modo) { console.error('uso: node ferramentas/aplicar-tema-ic.mjs <arquivo.html> --reparar | --verificar'); process.exit(2); }

// Tokens com alpha: valem para borda, divisor e overlay. NUNCA para fundo de superfície.
const TOKENS_ALPHA = ['--ic-border', '--ic-border-strong', '--ic-overlay'];
// Seletores em que esses tokens podem ser background (overlay e divisor).
const SELETOR_PERMITIDO = /overlay|crm-conv-modal|::before|::after|divider/i;
// Superfícies que PRECISAM ter fundo opaco no CSS final.
const SUPERFICIES_OPACAS = ['.modal-card', '.crm-conv-card', '.crm-fila', '.month-picker-dropdown', '.inad-multi-dropdown', '.login-card', '.sidebar', '.toast'];
const OPACO = /^(var\(--ic-(white|bg|bg-ice|bg-card|primary|accent|secondary|danger|muted)\)|var\(--bg-sidebar\)|#[0-9a-f]{6}\b)/i;

// ---------- constantes de cor ----------
const rootIC = `:root {
            /* Tokens Instituto Castro (Parte 2 do pedido). Usar exclusivamente estes. */
            --ic-primary:       #0E0E25;
            --ic-secondary:     #2D6298;
            --ic-text:          #5F5F5F;
            --ic-accent:        #0294AD;
            --ic-accent-dark:   #0A828E;
            --ic-green:         #A3CC83;
            --ic-bg:            #F9F9FE;
            --ic-bg-ice:        #F3FBFF;
            --ic-bg-card:       #F3FEFF;
            --ic-white:         #FFFFFF;
            --ic-muted:         #727586;
            --ic-border:        #2C2C770F;
            --ic-border-strong: #2C2C775E;
            --ic-star:          #FEC42D;
            --ic-danger:        #C02B0A;
            /* Com alpha (só transparência dos tokens acima; nenhuma cor nova).
               --ic-border, --ic-border-strong e --ic-overlay NUNCA são fundo de superfície. */
            --ic-overlay:        rgba(14, 14, 37, 0.45);
            --ic-accent-soft:    #0294AD1A;
            --ic-secondary-soft: #2D62981A;
            --ic-danger-soft:    #C02B0A1F;
            --ic-star-soft:      #FEC42D33;
            --ic-green-soft:     #A3CC8333;
            --ic-sombra-modal:   0 4px 8px #A5AED526;
            /* Escala única de camadas. Nenhum z-index global fora desta escala (valores locais, até 10, ficam nos componentes). */
            --z-sidebar:       100;
            --z-dropdown:      200;
            --z-drawer:        300;  /* painel lateral do card */
            --z-modal-overlay: 400;
            --z-modal:         410;  /* confirmação, Adicionar Cliente etc. */
            --z-popover:       500;  /* tooltips */
            --z-toast:         600;
            --z-boot:          700;  /* tela de carregamento inicial */
            /* Layout: a sidebar e o .main-content usam o MESMO token (antes: 270 contra margin-left 240). */
            --ic-sidebar-w:       270px;
            --ic-content-gutter:  32px;  /* desktop; 24px até 1023px e 16px até 767px, no tema-ic.css */
            /* Aliases das variáveis legadas: o CSS existente continua válido */
            --cor-primaria: var(--ic-accent);
            --cor-primaria-hover: var(--ic-accent-dark);
            --bg-sidebar: var(--ic-bg-ice);
            --bg-content: var(--ic-bg);
            --bg-card: var(--ic-white);
            --texto-primario: var(--ic-text);
            --texto-secundario: var(--ic-muted);
            --border-radius: 10px;
            --sombra-card: none;
            --sombra-card-hover: none;
        }`;

// ---------- utilitários de CSS ----------
// Separa o html em [antes do <style>, conteúdo do <style>, depois do </style>].
function partes(html) {
  const a = html.indexOf('<style>'), b = html.indexOf('</style>');
  if (a < 0 || b < 0) throw new Error('<style> não encontrado');
  return [html.slice(0, a + 7), html.slice(a + 7, b), html.slice(b)];
}
const REGRA = /([^{}@][^{}]*)\{([^{}]*)\}/g;
function regrasDe(css) {
  const out = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(REGRA)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':'); if (i < 0) continue;
      out.push({ sel, prop: d.slice(0, i).trim().toLowerCase(), val: d.slice(i + 1).trim() });
    }
  }
  return out;
}
const usaAlpha = (v) => TOKENS_ALPHA.some(t => v.includes('var(' + t + ')'));
const ehFundo = (p) => p === 'background' || p === 'background-color';

// Troca token com alpha por token opaco em background de não-overlay/não-divisor.
//   --ic-border        -> --ic-bg-ice  (trilho, chip, hover claro)
//   --ic-border-strong -> --ic-muted   (controle desligado, ponto de "digitando")
function corrigirSuperficies(html) {
  const [pre, css, pos] = partes(html);
  let n = 0;
  const trocaDecl = (v) => v.replace(/var\(--ic-border-strong\)/g, () => { n++; return 'var(--ic-muted)'; })
                            .replace(/var\(--ic-border\)/g, () => { n++; return 'var(--ic-bg-ice)'; });
  const cssNovo = css.replace(REGRA, (todo, sel, corpo) => {
    if (SELETOR_PERMITIDO.test(sel)) return todo;
    const novoCorpo = corpo.replace(/(^|;)(\s*)(background(?:-color)?)(\s*:\s*)([^;]*)/gi, (m, ini, esp, prop, dp, val) => ini + esp + prop + dp + (usaAlpha(val) ? trocaDecl(val) : val));
    return novoCorpo === corpo ? todo : sel + '{' + novoCorpo + '}';
  });
  // background inline em strings de JS/HTML (style="background:var(--ic-border)")
  const inline = (trecho) => trecho.replace(/(background(?:-color)?\s*:\s*)(var\(--ic-border(?:-strong)?\))/gi, (m, p, v) => { n++; return p + (v.includes('strong') ? 'var(--ic-muted)' : 'var(--ic-bg-ice)'); });
  return { html: inline(pre) + cssNovo + inline(pos), trocas: n };
}

// ---------- verificações ----------
function verificar(html) {
  const problemas = [];
  const [pre, css, pos] = partes(html);
  // 1. custom property que aponta para si mesma (inválida: vira transparente)
  for (const m of html.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*\1\s*[,)]/gi)) problemas.push('token referencia a si mesmo: ' + m[1]);
  // 1b. todo token --ic-* do :root tem de ser literal (não var())
  const root = (css.match(/:root\s*\{[^}]*\}/) || [''])[0];
  for (const m of root.matchAll(/(--ic-[a-z-]+)\s*:\s*(var\([^;]*)/g)) problemas.push('token --ic-* definido por var(): ' + m[1]);
  for (const t of ['--ic-white', '--ic-overlay', '--ic-border', '--ic-border-strong']) if (!new RegExp(t + '\\s*:').test(root)) problemas.push('token ausente no :root: ' + t);
  // 2. token com alpha como fundo fora de overlay/divisor (CSS)
  const regras = regrasDe(css);
  for (const r of regras) if (ehFundo(r.prop) && usaAlpha(r.val) && !SELETOR_PERMITIDO.test(r.sel)) problemas.push(`fundo com token alpha: ${r.sel} { ${r.prop}: ${r.val} }`);
  // 2b. idem inline (JS/HTML)
  for (const trecho of [pre, pos]) for (const m of trecho.matchAll(/background(?:-color)?\s*:\s*var\(--ic-(border|border-strong|overlay)\)/gi)) {
    // overlay inline só vale em camada de tela cheia (position:fixed na mesma declaração)
    if (m[1] === 'overlay' && /position\s*:\s*fixed/i.test(trecho.slice(Math.max(0, m.index - 200), m.index + m[0].length + 80))) continue;
    problemas.push('fundo inline com token alpha: ' + m[0]);
  }
  // 3. overlays usam --ic-overlay
  for (const r of regras) if (ehFundo(r.prop) && /overlay|crm-conv-modal/i.test(r.sel) && !/::|:hover/.test(r.sel) && /rgba?\(/.test(r.val)) problemas.push(`overlay fora do token: ${r.sel} { ${r.prop}: ${r.val} }`);
  // 3b. escala de camadas: nenhum z-index global (>= 50) literal fora da escala
  for (const m of html.matchAll(/z-index\s*:\s*(\d+)(?![\d.])/gi)) if (parseInt(m[1], 10) >= 50) problemas.push('z-index solto fora da escala: ' + m[0]);
  for (const t of ['--z-sidebar', '--z-dropdown', '--z-drawer', '--z-modal-overlay', '--z-modal', '--z-popover', '--z-toast']) if (!new RegExp(t + '\s*:').test(root)) problemas.push('token de camada ausente no :root: ' + t);
  // 3c. layout: sidebar e conteúdo precisam usar o mesmo token de largura, e o gutter tem de existir
  for (const t of ['--ic-sidebar-w', '--ic-content-gutter']) if (!new RegExp(t + '\\s*:').test(root)) problemas.push('token de layout ausente no :root: ' + t);
  if (!regras.some(r => r.sel === '.main-content' && r.prop === 'margin-left' && r.val.includes('var(--ic-sidebar-w)'))) problemas.push('.main-content precisa de margin-left: var(--ic-sidebar-w) (senão o conteúdo invade a sidebar)');
  if (!regras.some(r => r.sel === '.main-content' && r.prop === 'padding' && r.val.includes('var(--ic-content-gutter)'))) problemas.push('.main-content precisa de padding horizontal com var(--ic-content-gutter)');
  if (regras.some(r => r.sel === '.sidebar' && r.prop === 'width' && /^\d+px/.test(r.val) && r.val !== '0px') && !regras.some(r => r.sel === '.sidebar' && r.prop === 'width' && r.val.includes('var(--ic-sidebar-w)'))) problemas.push('.sidebar com largura fixa em px sem o token --ic-sidebar-w');
  // 4. superfícies que precisam ser opacas
  for (const sel of SUPERFICIES_OPACAS) {
    const bg = regras.filter(r => r.sel.split(',').map(s => s.trim()).includes(sel) && ehFundo(r.prop)).pop();
    if (!bg) problemas.push('superfície sem background: ' + sel);
    else if (!OPACO.test(bg.val.replace(/\s*!important/, ''))) problemas.push(`superfície sem fundo opaco: ${sel} { background: ${bg.val} }`);
  }
  return problemas;
}

function relatorio(html) {
  const tokens = new Set(['#0E0E25','#2D6298','#5F5F5F','#0294AD','#0A828E','#A3CC83','#F9F9FE','#F3FBFF','#F3FEFF','#FFFFFF','#727586','#FEC42D','#C02B0A']);
  const sobras = [...html.matchAll(/#[0-9A-Fa-f]{6}(?![0-9A-Fa-f])/g)].map(m => m[0].toUpperCase()).filter(h => !tokens.has(h));
  const cont = {}; for (const h of sobras) cont[h] = (cont[h] || 0) + 1;
  return cont;
}

// Escala de camadas: troca todo z-index global (>= 50) por token. Valores locais (< 50) ficam.
const Z_MAPA = {
  999999: 'var(--z-boot)', 99999: 'var(--z-popover)',
  10250: 'calc(var(--z-modal-overlay) + 2)', 10200: 'calc(var(--z-modal-overlay) + 1)', 10000: 'var(--z-modal-overlay)',
  9999: 'var(--z-drawer)', 9500: 'var(--z-dropdown)',
  2000: 'var(--z-toast)', 1100: 'var(--z-dropdown)', 1000: 'var(--z-modal-overlay)', 900: 'var(--z-dropdown)',
  200: 'var(--z-dropdown)', 103: 'calc(var(--z-sidebar) + 3)', 102: 'calc(var(--z-sidebar) + 2)', 101: 'calc(var(--z-sidebar) + 1)', 100: 'var(--z-sidebar)',
};
function mapearZIndex(html) {
  return html.replace(/(z-index\s*:\s*)(\d+)(?![\d.])/gi, (m, p, n) => (Z_MAPA[n] !== undefined ? p + Z_MAPA[n] : m));
}

// rgba do laranja/cinza antigos -> teal/azul; overlays (preto/ardósia com alpha) -> token único.
function normalizarRgbaEOverlays(html) {
  html = html.replace(/rgba\(240,\s*78,\s*35,/g, 'rgba(2,148,173,');
  html = html.replace(/rgba\(255,\s*107,\s*0,/g, 'rgba(2,148,173,');
  html = html.replace(/rgba\(255,\s*23,\s*68,/g, 'rgba(192,43,10,');
  html = html.replace(/rgba\(44,\s*48,\s*68,/g, 'rgba(45,98,152,');

  // overlays (preto/azul-ardósia com alpha) -> token único
  html = html.replace(/(background\s*:\s*)rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.5\d*\s*\)/g, '$1var(--ic-overlay)');
  html = html.replace(/(background\s*:\s*)rgba\(\s*15\s*,\s*15\s*,\s*20\s*,\s*0?\.45\s*\)/g, '$1var(--ic-overlay)');
  html = html.replace(/(background\s*:\s*)rgba\(\s*15\s*,\s*23\s*,\s*42\s*,\s*0?\.45\s*\)/g, '$1var(--ic-overlay)');
  return html;
}

// Leva o index.html ao estado atual do tema (idempotente): troca o :root e o bloco do tema
// pelos atuais e normaliza rgba/overlays e z-index.
function reinstalarRootETema(html) {
  const rootAtual = /:root\s*\{[^}]*--ic-primary:[^}]*\}/;
  if (!rootAtual.test(html)) throw new Error(':root com tokens IC não encontrado (arquivo não tematizado?)');
  html = html.replace(rootAtual, rootIC);
  html = normalizarRgbaEOverlays(html);
  html = mapearZIndex(html);
  const marca = '/* ===== TEMA INSTITUTO CASTRO';
  const i = html.indexOf(marca), fimStyle = html.indexOf('</style>');
  if (i < 0 || fimStyle < i) throw new Error('bloco do tema não encontrado');
  const tema = fs.readFileSync(path.join(aqui, 'tema-ic.css'), 'utf8');
  const linhaInicio = html.lastIndexOf('\n', i) + 1;
  return html.slice(0, linhaInicio) + '        /* ===== TEMA INSTITUTO CASTRO (gerado por ferramentas/aplicar-tema-ic.mjs) ===== */\n' + tema + '\n    ' + html.slice(fimStyle);
}

// ---------- execução ----------
let html = fs.readFileSync(arquivo, 'utf8');
let fundos = 0;
if (modo === 'reparar') html = reinstalarRootETema(html);
if (modo !== 'verificar') {
  const r = corrigirSuperficies(html); html = r.html; fundos = r.trocas;
}
const problemas = verificar(html);
if (problemas.length) {
  console.error('FALHOU: ' + problemas.length + ' problema(s). Nada foi gravado.');
  for (const p of problemas.slice(0, 40)) console.error(' - ' + p);
  process.exit(1);
}
if (modo !== 'verificar') fs.writeFileSync(arquivo, html);
console.log('ok', { modo, bytes: html.length, trocasHex: 0, fundosCorrigidos: fundos, verificacoes: 'sem problemas', hexForaDosTokens: relatorio(html) });
