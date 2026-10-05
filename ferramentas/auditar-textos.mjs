// Varredura de TEXTO VISÍVEL de outro contexto de negócio (empresa, aluno, curso, turma, matrícula...).
// Procura em texto de HTML e em literais de string do JS; ignora identificadores (classes, ids, colunas).
// Uso: node ferramentas/auditar-textos.mjs index.html ic-extensoes.js [...]
import fs from 'node:fs';

const termos = '(?:empresas?|alunos?|cursos?|turmas?|matr[ií]culas?|mensalidades?|inadimpl[êe]ncia|inadimplentes?|vestibular|franquias?|franqueados?|colaboradores?)';
const re = new RegExp('(?<![\\w\\-_.#$/])' + termos + '(?![\\w\\-_])', 'gi');
const ignorarLinha = /^\s*(\/\/|\/\*|\*|<!--)/;

for (const arq of process.argv.slice(2)) {
    const linhas = fs.readFileSync(arq, 'utf8').split('\n');
    let emStyle = false;
    linhas.forEach((l, i) => {
        if (/<style/i.test(l)) emStyle = true;
        if (emStyle) { if (/<\/style>/i.test(l)) emStyle = false; return; }
        if (ignorarLinha.test(l)) return;
        // só o que está entre aspas ou entre > <
        const pedacos = [];
        l.replace(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|>([^<>]+)</g, (m, a, b, c) => { pedacos.push(a || b || c || ''); return m; });
        for (const p of pedacos) {
            if (!/\s/.test(p) && p.length < 4) continue;
            re.lastIndex = 0;
            const hit = p.match(re);
            if (hit) { console.log(arq + ':' + (i + 1) + ': [' + [...new Set(hit.map(x => x.toLowerCase()))].join(',') + '] ' + p.trim().slice(0, 150)); break; }
        }
    });
}
