// Pos-validacao por CODIGO da resposta gerada pela IA (Resolucao CFM
// 2.336/2023): nada de medicamento, dose, diagnostico, promessa de resultado
// ou receita sai para o lead, mesmo que o modelo escorregue. Valor em dinheiro
// so os confirmados pelo Instituto (VALORES_CONFIRMADOS).
// Devolve o termo que bateu (para o log) ou null quando a resposta esta limpa.
import { normalizarTexto } from "./texto.ts";

// Frases com "voce tem"/"voce teria" que sao perguntas de atendimento, nao
// afirmacoes clinicas. Sao removidas antes de aplicar a regra.
const EXCECOES_VOCE_TEM =
  /voce (?:tem|teria) (?:alguma |uma |mais alguma |outra |algum )?(?:preferencia|disponibilidade|interesse|duvida|duvidas|pergunta|perguntas|horario|convenio|plano de saude|plano)/g;

// Mounjaro/tirzepatida: o Instituto confirmou a resposta (30/10/2026) em que a
// indicacao e a dose sao definidas na consulta. So essas frases passam com "dose".
const EXCECOES_DOSE =
  /\b(?:definir|define|definida|definido|avaliar)\s+(?:a\s+)?(?:indicacao\s+(?:de\s+[\w/ ]{1,30}?\s+)?e\s+(?:a\s+)?)?dose(?:\s+adequada)?\b|\ba dose (?:adequada )?(?:e |sera |precisa ser )?definida pelo medico\b/g;

// Valores confirmados pelo Instituto em 29 e 30/10/2026 (consulta com o
// cirurgiao e avaliacao da Assessoria em Emagrecimento: R$ 500,00). Qualquer
// outro valor e barrado.
const VALORES_CONFIRMADOS = new Set(["500"]);
const RE_VALOR = /r\$\s*(\d+(?:[.,]\d{3})*(?:,\d{1,2})?)|\b(\d+(?:[.,]\d{3})*(?:,\d{1,2})?)\s*reais\b/g;

function valorNaoConfirmado(t: string): string | null {
  for (const m of t.matchAll(RE_VALOR)) {
    const inteiro = (m[1] || m[2] || "").replace(/,\d{1,2}$/, "").replace(/[.,]/g, "");
    if (!VALORES_CONFIRMADOS.has(inteiro)) return m[0];
  }
  return null;
}

const REGRAS: Array<{ nome: string; re: RegExp }> = [
  { nome: "medicamento", re: /\b(ozempic|wegovy|saxenda|semaglutida|liraglutida|orlistat|sibutramina|metformina|contrave|rybelsus|victoza)\b/ },
  { nome: "mg", re: /\b\d+(?:[.,]\d+)?\s*mg\b|\bmg\b/ },
  { nome: "dose", re: /\bdoses?\b|\bdosagem\b/ },
  { nome: "garantia", re: /\bgarantimos\b|\bgarantid[oa]s?\b|\bgarantia de resultado\b/ },
  { nome: "voce_tem", re: /\bvoce (?:tem|esta com)\b/ },
  { nome: "diagnostico", re: /\bdiagnostic[oa]s?\b|\bdiagnosticad[oa]\b/ },
  { nome: "receita", re: /\breceitas?\b|\bprescri(?:cao|coes|ver|revemos)\b/ },
  { nome: "medicacao", re: /\bmedicamentos?\b|\bremedios?\b|\bmedicacao\b/ },
];

export function respostaProibida(texto: string): string | null {
  const t = normalizarTexto(texto).replace(EXCECOES_VOCE_TEM, " ").replace(EXCECOES_DOSE, " ");
  if (!t) return null;
  for (const r of REGRAS) {
    const m = r.re.exec(t);
    if (m) return `${r.nome}:${m[0]}`;
  }
  const valor = valorNaoConfirmado(t);
  return valor ? `valor:${valor}` : null;
}
