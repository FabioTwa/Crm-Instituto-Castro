// Corrige acentuação de TEXTO VISÍVEL no index.html e nos .js do front. Dev-only: requer acorn
// (`npm i --no-save acorn` na pasta ferramentas ou no scratchpad). Sem acorn o projeto continua
// sem build e sem dependência: este script não roda em produção.
//
//   node ferramentas/corrigir-acentos.mjs <index.html> [outro.js ...]   corrige e grava
//   node ferramentas/corrigir-acentos.mjs <index.html> --verificar       só lista o que falta
//
// Regras: só mexe em literais de string e templates com texto de tela (têm espaço ou começam
// em maiúscula) e em textos/atributos visíveis do HTML. Nunca mexe em identificadores, nomes
// de coluna, listas de colunas do CSV nem URLs. Preserva maiúsculas (Nao -> Não, NAO -> NÃO).
import fs from 'node:fs';
import { parse } from 'acorn';

const D = {
  acao: 'ação', acoes: 'ações', nao: 'não', voce: 'você', voces: 'vocês', sera: 'será', serao: 'serão', tambem: 'também', alem: 'além', apos: 'após',
  historico: 'histórico', usuario: 'usuário', usuarios: 'usuários', numero: 'número', numeros: 'números', codigo: 'código', endereco: 'endereço',
  informacao: 'informação', informacoes: 'informações', observacao: 'observação', configuracao: 'configuração', configuracoes: 'configurações',
  atencao: 'atenção', conversao: 'conversão', negociacao: 'negociação', avaliacao: 'avaliação', horario: 'horário', horarios: 'horários',
  periodo: 'período', periodos: 'períodos', proximo: 'próximo', proxima: 'próxima', proximos: 'próximos', ultimo: 'último', ultima: 'última', ultimos: 'últimos', ultimas: 'últimas',
  unico: 'único', unica: 'única', pagina: 'página', relatorio: 'relatório', saude: 'saúde', clinica: 'clínica', funcao: 'função', selecao: 'seleção',
  invalido: 'inválido', invalida: 'inválida', obrigatorio: 'obrigatório', obrigatoria: 'obrigatória', inicio: 'início', minimo: 'mínimo', maximo: 'máximo', titulo: 'título',
  tres: 'três', conexao: 'conexão', versao: 'versão', exclusao: 'exclusão', criacao: 'criação', atribuicao: 'atribuição', permissao: 'permissão', permissoes: 'permissões',
  sessao: 'sessão', disponivel: 'disponível', indisponivel: 'indisponível', possivel: 'possível', impossivel: 'impossível', ordenacao: 'ordenação', operacao: 'operação',
  duplicacao: 'duplicação', distribuicao: 'distribuição', redistribuicao: 'redistribuição', integracao: 'integração', importacao: 'importação', exportacao: 'exportação',
  prospeccao: 'prospecção', indicacao: 'indicação', confirmacao: 'confirmação', transcricao: 'transcrição', ligacao: 'ligação', reuniao: 'reunião',
  medico: 'médico', medica: 'médica', responsavel: 'responsável', responsaveis: 'responsáveis', variavel: 'variável', nivel: 'nível', gestao: 'gestão',
  convenio: 'convênio', convenios: 'convênios', preco: 'preço', precos: 'preços', alteracao: 'alteração', alteracoes: 'alterações', solicitacao: 'solicitação',
  solicitacoes: 'solicitações', duvida: 'dúvida', duvidas: 'dúvidas', sao: 'são', tecnico: 'técnico', valido: 'válido', avancado: 'avançado', analise: 'análise',
  analises: 'análises', orcamento: 'orçamento', prontuario: 'prontuário', notificacao: 'notificação', comunicacao: 'comunicação', edicao: 'edição', atualizacao: 'atualização',
  geracao: 'geração', gravacao: 'gravação', transferencia: 'transferência', referencia: 'referência', ocorrencia: 'ocorrência', experiencia: 'experiência', frequencia: 'frequência',
  publico: 'público', basico: 'básico', irmaos: 'irmãos', carregaram: 'carregaram', vazio: 'vazio',
};
// Palavras com outra leitura válida sem acento, e nomes de coluna: nunca automáticas.
const EXCLUIR = new Set(['ja', 'so', 'ate', 'ha', 'la', 'pre', 'pos', 'mes', 'alo', 'email', 'observacoes', 'profissao', 'secao', 'descricao', 'rotulo', 'area', 'carregaram', 'vazio']);
// Unicode: letra acentuada conta como letra (paginação não casa "pagina"). Palavra colada a barra invertida é argumento, não texto.
const RE = new RegExp('(?<![\\p{L}\\d_@.\\\\\'"-])(' + Object.keys(D).filter(k => !EXCLUIR.has(k)).join('|') + ')(?![\\p{L}\\d_-]|\\\\?[\'"])', 'giu');
const LISTA_DE_COLUNAS = /^\s*[a-z_]+(\s*,\s*[a-z_]+){2,}\s*$/i;

function caso(orig, certo) {
  if (orig === orig.toUpperCase() && orig.length > 1) return certo.toUpperCase();
  if (orig[0] === orig[0].toUpperCase()) return certo[0].toUpperCase() + certo.slice(1);
  return certo;
}
const consertar = (t) => t.replace(RE, (m) => caso(m, D[m.toLowerCase()]));
const visivel = (v) => { const t = v.trim(); return (/\s/.test(t) || /^[A-ZÀ-Ú]/.test(t)) && !LISTA_DE_COLUNAS.test(t) && !/^(https?:|[.#][\w-]|[a-z-]+:[^ ])/i.test(t); };

let trocas = 0;
function jsCorrigir(codigo) {
  const ast = parse(codigo, { ecmaVersion: 'latest', sourceType: 'script' });
  const ed = [];
  (function visit(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Literal' && typeof n.value === 'string' && visivel(n.value)) {
      // sem as aspas externas do literal: a palavra encostada nelas seria tratada como argumento/chave
      const raw = codigo.slice(n.start, n.end), novo = raw[0] + consertar(raw.slice(1, -1)) + raw.slice(-1);
      if (novo !== raw) ed.push({ start: n.start, end: n.end, texto: novo });
    }
    if (n.type === 'TemplateElement') {
      const raw = codigo.slice(n.start, n.end), novo = consertar(raw);
      if (novo !== raw) ed.push({ start: n.start, end: n.end, texto: novo });
    }
    for (const k in n) { const c = n[k]; if (Array.isArray(c)) c.forEach(visit); else if (c && typeof c.type === 'string') visit(c); }
  })(ast);
  ed.sort((a, b) => b.start - a.start);
  for (const e of ed) { codigo = codigo.slice(0, e.start) + e.texto + codigo.slice(e.end); trocas++; }
  parse(codigo, { ecmaVersion: 'latest', sourceType: 'script' });
  return { codigo, n: ed.length };
}

const alvos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const soVerificar = process.argv.includes('--verificar');
let faltam = 0;
for (const arq of alvos) {
  let src = fs.readFileSync(arq, 'utf8');
  if (arq.endsWith('.html')) {
    // 1) scripts inline
    src = src.replace(/(<script(?![^>]*src=)[^>]*>)([\s\S]*?)(<\/script>)/g, (m, a, js, c) => { const r = jsCorrigir(js); return a + r.codigo + c; });
    // 2) texto visível do HTML (fora de script/style) e atributos de tela
    src = src.replace(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)|>([^<>]+)(?=<)/g, (m, bloco, txt) => {
      if (bloco) return bloco; if (!txt.trim() || LISTA_DE_COLUNAS.test(txt) || /Colunas esperadas/.test(txt)) return m;
      const n = consertar(txt); if (n !== txt) trocas++; return '>' + n; // sem consumir o '<' final (senão o <script> seguinte deixa de ser reconhecido)
    });
    src = src.replace(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)|((?:placeholder|title|alt|aria-label)=")([^"]+)(")/g, (m, bloco, a, v, c) => {
      if (bloco) return bloco; const n = consertar(v); if (n !== v) trocas++; return a + n + c;
    });
  } else {
    src = jsCorrigir(src).codigo;
  }
  if (!soVerificar) fs.writeFileSync(arq, src);
  else faltam = trocas;
}
console.log(soVerificar ? `faltam ${faltam} correção(ões)` : `corrigidos ${trocas} trecho(s) de texto`);
if (soVerificar && faltam) process.exit(1);
