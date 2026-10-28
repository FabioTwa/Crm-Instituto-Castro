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

// detectarAgendamento: a conversa entrou em agendamento. O lead pediu para
// marcar ou falou de dia/horario, ou a resposta da IA ofereceu data/horario.
// Move o card para "agendamento pendente" sem esperar a reserva do horario.
const RE_AGENDAMENTO_LEAD =
  /\b(agendar|agendamento|agenda|marcar|marcacao|remarcar|horario|horarios|disponibilidade|disponivel|vaga|vagas|que dia|qual dia|amanha|segunda|terca|quarta|quinta|sexta|sabado|semana que vem|proxima semana)\b/;
// Na resposta da IA: uma data (12/11) ou um horario ("as 15h", "as 15:30").
const RE_AGENDAMENTO_IA = /\b\d{1,2}\/\d{1,2}\b|\bas \d{1,2}(:\d{2}|h)/;

// Devolve o motivo (para o log) ou null.
export function detectarAgendamento(textoLead: string, textoResposta: string): string | null {
  const lead = normalizarTexto(textoLead).match(RE_AGENDAMENTO_LEAD);
  if (lead) return `lead falou de agendamento ("${lead[0]}")`;
  if (RE_AGENDAMENTO_IA.test(normalizarTexto(textoResposta))) return "a IA ofereceu data ou horário";
  return null;
}
