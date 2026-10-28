// Interpretacao da resposta do lead ao pedido de consentimento (LGPD).
// Regex pt-BR simples sobre o texto normalizado. Ambiguidade = nao responde.
import { normalizarTexto } from "./texto.ts";

export type Consentimento = "sim" | "nao" | "ambiguo";

const RE_SIM =
  /\b(sim|aceito|aceita|concordo|pode|pode sim|ok|okay|okey|claro|autorizo|tudo bem|ta bom|ta bem|beleza|com certeza|isso|positivo|de acordo|certo|fechado|bora|vamos|pode ser|tranquilo|show|podemos|pode seguir|podemos seguir|pode continuar|segue|siga|seguir|prosseguir|continuar)\b|^s$|\u{1F44D}|✅/u;

const RE_NAO =
  /\bnao\b|\bnegativo\b|\bdiscordo\b|\brecuso\b|^n$|❌|\u{1F44E}/u;

// Negativas explicitas que carregam uma palavra de "sim" dentro ("nao aceito",
// "nao concordo"): decidem sozinhas, antes da contagem.
const RE_NAO_FORTE =
  /\b(nao (?:aceito|concordo|autorizo|quero|pode|podemos|desejo)|prefiro nao|nao, obrigad[oa])\b/;

export function interpretarConsentimento(texto: string): Consentimento {
  const t = normalizarTexto(texto);
  if (!t) return "ambiguo";
  if (RE_NAO_FORTE.test(t)) return "nao";
  const sim = RE_SIM.test(t);
  const nao = RE_NAO.test(t);
  if (nao && !sim) return "nao";
  if (sim && !nao) return "sim";
  // "sim, mas nao agora" / "nao sei se pode" -> humano decide; a IA nao responde.
  return "ambiguo";
}

// Pedido de autorizacao feito numa conversa que ja foi encerrada: a pessoa
// voltou depois e nao esta respondendo aquele pedido antigo, entao ele deve
// ser feito de novo (senao a primeira mensagem dela cai como "ambigua" e
// fica sem resposta).
export function pedidoDeConversaAnterior(pedidoEm: string | null | undefined, inicioConversaMs: number): boolean {
  if (!Number.isFinite(inicioConversaMs)) return false;
  const pedidoMs = Date.parse(String(pedidoEm || ""));
  return Number.isFinite(pedidoMs) && pedidoMs < inicioConversaMs;
}

// Quantos lembretes acolhedores a IA manda por conversa quando a resposta ao
// pedido nao e sim nem nao. Depois disso fica em silencio (sem consentimento
// a IA nao pode conduzir o atendimento).
export const MAX_LEMBRETES_CONSENTIMENTO = 2;

// Pedido de autorizacao na abertura da conversa: so com
// crm_ia_config.pedir_consentimento = 'true'. Desligado (padrao desde
// 28/10/2026, decisao do Fabio), a Julie abre a conversa se apresentando como
// uma atendente; o tratamento dos dados segue a base legal de tutela da saude
// (LGPD art. 11, II, f) e a politica de privacidade do Instituto.
export function pedirConsentimento(cfg: Record<string, string>): boolean {
  return String(cfg.pedir_consentimento ?? "").trim().toLowerCase() === "true";
}

// Lembrete de confirmacao e retomadas: com o pedido desligado, so fica de fora
// quem recusou expressamente em algum pedido antigo.
export function consentimentoLibera(cfg: Record<string, string>, status: string | null | undefined): boolean {
  const s = String(status || "").toLowerCase();
  if (pedirConsentimento(cfg)) return s === "concedido";
  return s !== "negado" && s !== "revogado";
}
