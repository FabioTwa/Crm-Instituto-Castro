// Encerramento por inatividade da conversa com a IA (crm_ia_config):
//
//   encerrar_apos_minutos  minutos sem resposta do lead depois da ULTIMA
//                          mensagem da IA para encerrar a conversa. Padrao 60.
//                          '0' desliga. Limitado a 5..1440.
//
// Encerrar = mandar uma despedida curta (so dentro do horario de atendimento e
// da janela de 24 h do WhatsApp) e gravar em ia_decisoes_log uma linha com
// etapa_pipeline='encerramento'. Fora do horario a conversa e encerrada sem
// mensagem. A proxima mensagem do lead abre uma conversa nova: o limite
// max_respostas_por_conversa volta a contar do zero.
//
// Logica pura (sem banco) para ser testavel.

export const ETAPA_ENCERRAMENTO = "encerramento";
export const ENCERRAR_PADRAO_MIN = 60;

export function minutosEncerramento(cfg: Record<string, string>): number {
  const bruto = String(cfg.encerrar_apos_minutos ?? "").trim();
  if (bruto === "") return ENCERRAR_PADRAO_MIN;
  const n = Math.floor(Number(bruto));
  if (!Number.isFinite(n)) return ENCERRAR_PADRAO_MIN;
  if (n <= 0) return 0;
  return Math.min(1440, Math.max(5, n));
}

export type UltimaMensagem = { autor: string | null; criada_em: string; payload_raw?: Record<string, unknown> | null };

export type DecisaoEncerramento = "enviar" | "sem_mensagem" | null;

// null = nao encerra (ainda dentro do prazo, quem falou por ultimo nao foi a
// IA, ja encerrada, ou ha humano no controle).
export function decidirEncerramento(a: {
  ultima: UltimaMensagem | null;
  agora: Date;
  minutos: number;
  ultimoEncerramentoEm: string | null;
  handoffPendente: boolean;
  dentroDoHorario: boolean;
}): DecisaoEncerramento {
  if (a.minutos <= 0 || !a.ultima || a.handoffPendente) return null;
  if (a.ultima.autor !== "ia") return null;
  if (a.ultima.payload_raw && (a.ultima.payload_raw as any).encerramento === true) return null;
  const ultimaMs = Date.parse(a.ultima.criada_em);
  if (!Number.isFinite(ultimaMs)) return null;
  if (a.ultimoEncerramentoEm && Date.parse(a.ultimoEncerramentoEm) >= ultimaMs) return null;
  const parado = a.agora.getTime() - ultimaMs;
  if (parado < a.minutos * 60000) return null;
  // Despedida so dentro do horario e da janela de 24 h do WhatsApp.
  if (!a.dentroDoHorario || parado >= 24 * 3600 * 1000) return "sem_mensagem";
  return "enviar";
}
