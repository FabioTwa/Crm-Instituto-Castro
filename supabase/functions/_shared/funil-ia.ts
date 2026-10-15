// Card anda sozinho pelo funil conforme a conversa (SQL 33, ic_avancar_etapa).
//
// detectarNegociacao: o lead perguntou de valor, pagamento, convenio ou formato
// do atendimento. Regex sobre a ultima mensagem do lead, como as regras de
// handoff: barato, deterministico e sem depender de a IA chamar uma ferramenta.
// Falso-positivo aqui so adianta o card uma etapa (nunca volta, nunca fecha).
import { normalizarTexto } from "./texto.ts";

export type EventoFunil = "conversa" | "negociacao" | "proposta";

const RE_NEGOCIACAO =
  /\b(valor|valores|preco|precos|quanto custa|quanto fica|quanto sai|quanto e|quanto eh|custo|custa|orcamento|tabela|convenio|convenios|plano de saude|aceita plano|aceitam plano|particular|reembolso|parcela\w*|parcelar|parcelado|pix|cartao|boleto|forma de pagamento|formas de pagamento|pagamento|desconto|online|on-line|presencial|teleconsulta)\b/;

// Devolve o termo encontrado (para o log) ou null.
export function detectarNegociacao(textoLead: string): string | null {
  const t = normalizarTexto(textoLead);
  if (!t) return null;
  const m = t.match(RE_NEGOCIACAO);
  return m ? m[0] : null;
}
