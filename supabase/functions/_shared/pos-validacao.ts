// Pos-validacao por CODIGO da resposta gerada pela IA (Resolucao CFM
// 2.336/2023): nada de medicamento, dose, diagnostico, promessa de resultado
// ou receita sai para o lead, mesmo que o modelo escorregue.
// Devolve o termo que bateu (para o log) ou null quando a resposta esta limpa.
import { normalizarTexto } from "./texto.ts";

// Frases com "voce tem"/"voce teria" que sao perguntas de atendimento, nao
// afirmacoes clinicas. Sao removidas antes de aplicar a regra.
const EXCECOES_VOCE_TEM =
  /voce (?:tem|teria) (?:alguma |uma |mais alguma |outra |algum )?(?:preferencia|disponibilidade|interesse|duvida|duvidas|pergunta|perguntas|horario|convenio|plano de saude|plano)/g;

const REGRAS: Array<{ nome: string; re: RegExp }> = [
  { nome: "medicamento", re: /\b(ozempic|mounjaro|wegovy|saxenda|tirzepatida|semaglutida|liraglutida|orlistat|sibutramina|metformina|contrave|rybelsus|victoza)\b/ },
  { nome: "mg", re: /\b\d+(?:[.,]\d+)?\s*mg\b|\bmg\b/ },
  { nome: "dose", re: /\bdoses?\b|\bdosagem\b/ },
  { nome: "garantia", re: /\bgarantimos\b|\bgarantid[oa]s?\b|\bgarantia de resultado\b/ },
  { nome: "voce_tem", re: /\bvoce (?:tem|esta com)\b/ },
  { nome: "diagnostico", re: /\bdiagnostic[oa]s?\b|\bdiagnosticad[oa]\b/ },
  { nome: "receita", re: /\breceitas?\b|\bprescri(?:cao|coes|ver|revemos)\b/ },
  { nome: "medicacao", re: /\bmedicamentos?\b|\bremedios?\b|\bmedicacao\b/ },
];

export function respostaProibida(texto: string): string | null {
  const t = normalizarTexto(texto).replace(EXCECOES_VOCE_TEM, " ");
  if (!t) return null;
  for (const r of REGRAS) {
    const m = r.re.exec(t);
    if (m) return `${r.nome}:${m[0]}`;
  }
  return null;
}
