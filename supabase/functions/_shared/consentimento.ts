// Interpretacao da resposta do lead ao pedido de consentimento (LGPD).
// Regex pt-BR simples sobre o texto normalizado. Ambiguidade = nao responde.
import { normalizarTexto } from "./texto.ts";

export type Consentimento = "sim" | "nao" | "ambiguo";

const RE_SIM =
  /\b(sim|aceito|aceita|concordo|pode|pode sim|ok|okay|okey|claro|autorizo|tudo bem|ta bom|ta bem|beleza|com certeza|isso|positivo|de acordo|certo|fechado|bora|vamos|pode ser|tranquilo|show)\b|^s$|\u{1F44D}|✅/u;

const RE_NAO =
  /\bnao\b|\bnegativo\b|\bdiscordo\b|\brecuso\b|^n$|❌|\u{1F44E}/u;

// Negativas explicitas que carregam uma palavra de "sim" dentro ("nao aceito",
// "nao concordo"): decidem sozinhas, antes da contagem.
const RE_NAO_FORTE =
  /\b(nao (?:aceito|concordo|autorizo|quero|pode|desejo)|prefiro nao|nao, obrigad[oa])\b/;

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
