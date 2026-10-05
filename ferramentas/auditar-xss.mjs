// Heurística de auditoria de XSS: lista linhas que montam HTML concatenando um campo de texto livre
// (nome, email, descricao...) sem passar por escapeHtml/escaparAtributo. Não prova ausência de falha,
// só aponta onde olhar. Uso: node ferramentas/auditar-xss.mjs index.html [ic-extensoes.js ...]
import fs from 'node:fs';

const campos = 'nome|name|email|telefone|descricao|observacoes|profissao|origem|label|titulo|motivo|usuario_nome|vendedor_nome|funil_nome|mensagem|texto|conteudo|cpf|anuncio_titulo|anuncio_texto|fonte|responsavel_nome|campanha';
const re = new RegExp('\\+\\s*([A-Za-z_$][\\w$]*(?:\\[[^\\]]+\\])?(?:\\.[\\w$]+)*\\.(?:' + campos + '))\\s*(?:\\|\\|[^+;]*)?\\+', 'g');
const seguro = /escapeHtml\(|escaparAtributo\(|escHtml\(|\besc\(|textContent|encodeURIComponent|sanitize|icFormatarTelefoneBR\(|icTelefoneFormatar\(|icCpfFormatar\(|icOrigemRotulo\(/;

for (const arq of process.argv.slice(2)) {
    const linhas = fs.readFileSync(arq, 'utf8').split('\n');
    linhas.forEach((l, i) => {
        if (!/<[a-z]/i.test(l)) return;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(l))) {
            const janela = l.slice(Math.max(0, m.index - 32), m.index + m[0].length + 4);
            if (seguro.test(janela)) continue;
            console.log(arq + ':' + (i + 1) + ': [' + m[1] + '] ' + l.trim().slice(0, 150));
            break;
        }
    });
}
