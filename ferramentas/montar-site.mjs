// Monta a pasta publicada na Vercel (site/) só com o que o navegador precisa.
// Roda no build da Vercel (vercel.json -> buildCommand). Também roda local:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node ferramentas/montar-site.mjs
//
// Por que existe:
//   1. config.js não vai para o git. Aqui ele é gerado a partir das variáveis de
//      ambiente do projeto na Vercel (SUPABASE_URL e SUPABASE_ANON_KEY).
//   2. Só os arquivos do front são publicados. SQL, Edge Functions, docs, testes e
//      demonstração ficam fora do site.
//
// Aborta o build (sem publicar nada) se faltar variável ou se a chave não for a anon.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destino = path.join(raiz, 'site');

const ARQUIVOS = ['index.html', 'encaixes.js', 'encaixes-depois.js', 'ic-extensoes.js', 'ic-validacao.js'];
const PASTAS = ['assets'];

function falhar(msg) {
    console.error('[montar-site] ' + msg);
    process.exit(1);
}

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const anon = String(process.env.SUPABASE_ANON_KEY || '').trim();

if (!url) falhar('variável SUPABASE_URL não definida.');
if (!anon) falhar('variável SUPABASE_ANON_KEY não definida.');
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
    falhar('SUPABASE_URL fora do formato https://<projeto>.supabase.co');
}

// A chave vai para o navegador: só a anon (ou a publishable) é aceita.
if (/^sb_secret_/.test(anon)) falhar('SUPABASE_ANON_KEY é uma chave secreta. Use a chave anon/publishable.');
const partes = anon.split('.');
if (partes.length === 3) {
    let role = '';
    try {
        role = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8')).role || '';
    } catch (e) {
        falhar('SUPABASE_ANON_KEY não é um JWT válido.');
    }
    if (role !== 'anon') falhar('SUPABASE_ANON_KEY tem role "' + role + '". Use a chave anon.');
} else if (!/^sb_publishable_/.test(anon)) {
    falhar('SUPABASE_ANON_KEY em formato desconhecido. Use a chave anon (JWT) ou sb_publishable_.');
}

fs.rmSync(destino, { recursive: true, force: true });
fs.mkdirSync(destino, { recursive: true });

for (const a of ARQUIVOS) {
    const origem = path.join(raiz, a);
    if (!fs.existsSync(origem)) falhar('arquivo do front não encontrado: ' + a);
    fs.copyFileSync(origem, path.join(destino, a));
}
for (const p of PASTAS) {
    fs.cpSync(path.join(raiz, p), path.join(destino, p), { recursive: true });
}

// Sem DEMO_LOCAL: o modo demonstração nunca vai para o site publicado.
const config = '// Gerado no build (ferramentas/montar-site.mjs). Não editar.\n' +
    'window.IC_CONFIG = ' + JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: anon }, null, 4) + ';\n';
fs.writeFileSync(path.join(destino, 'config.js'), config);

console.log('[montar-site] site/ pronto: ' + ARQUIVOS.length + ' arquivos, ' + PASTAS.join(', ') + ' e config.js (' + url + ').');
