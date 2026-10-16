// Rajada: no WhatsApp a pessoa manda UMA fala em varias mensagens seguidas
// ("Oi" / "tudo bem?" / "queria marcar"). Responder cada uma soa como robo.
// Cada mensagem recebida dispara a IA; a invocacao espera a pessoa parar de
// digitar e so a da ULTIMA mensagem responde, lendo a rajada inteira junto
// (mensagensParaClaude ja junta as mensagens seguidas do lead).
// Logica pura (sem banco) para ser testavel.

export const RAJADA_SILENCIO_MS = 3000; // sem mensagem nova por 3 s = terminou
export const RAJADA_TETO_MS = 12000; // nunca segura a resposta mais que isso
export const RAJADA_PASSO_MS = 700;

export type DecisaoRajada =
  | { acao: "responder" }
  | { acao: "absorvida" } // chegou mensagem depois: quem responde e a invocacao dela
  | { acao: "esperar"; ms: number };

export function decidirRajada(args: {
  gatilhoId: string;
  ultimaDoLead: { id: string; criada_em: string } | null;
  agoraMs: number;
  inicioEsperaMs: number;
  silencioMs?: number;
  tetoMs?: number;
}): DecisaoRajada {
  const silencio = args.silencioMs ?? RAJADA_SILENCIO_MS;
  const teto = args.tetoMs ?? RAJADA_TETO_MS;
  const ult = args.ultimaDoLead;
  if (!ult) return { acao: "responder" };
  if (ult.id !== args.gatilhoId) return { acao: "absorvida" };
  const quando = Date.parse(ult.criada_em);
  if (!Number.isFinite(quando)) return { acao: "responder" };
  const parado = args.agoraMs - quando;
  if (parado >= silencio) return { acao: "responder" };
  const restanteTeto = args.inicioEsperaMs + teto - args.agoraMs;
  if (restanteTeto <= 0) return { acao: "responder" };
  return { acao: "esperar", ms: Math.max(RAJADA_PASSO_MS, Math.min(silencio - parado, restanteTeto)) };
}
