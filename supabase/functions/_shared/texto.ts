// Normalizacao de texto para as regras por regex (handoff, consentimento,
// pos-validacao): minusculas, sem acento, espacos colapsados.
export function normalizarTexto(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Assinatura de quem responde pelo CRM: o nome do usuario em negrito na
// primeira linha e a mensagem logo abaixo, como no WhatsApp da clinica.
//   *Gabriel*
//   Boa tarde
// O nome perde os marcadores de formatacao do WhatsApp (* _ ~ `) e as quebras
// de linha, para nao quebrar o negrito. Sem nome, a mensagem segue sem
// assinatura. Assinada passaria do limite: segue sem assinatura.
export const MAX_NOME_ASSINATURA = 60;
export function assinarMensagem(nome: string | null | undefined, texto: string, limite = 4096): string {
  const limpo = String(nome || "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOME_ASSINATURA)
    .trim();
  if (!limpo) return texto;
  const assinado = "*" + limpo + "*\n" + texto;
  return assinado.length > limite ? texto : assinado;
}

// Primeiro nome para a Jully usar no cumprimento. O nome do WhatsApp pode vir com
// titulo ("Prof. Lilian"), emoji ou numeros ("Lilian 💫 2079"): pula titulos e
// palavras sem letra, e devolve null quando nao sobra um nome aproveitavel.
const TITULOS_NOME = new Set([
  "prof", "profa", "professor", "professora", "dr", "dra", "doutor", "doutora",
  "sr", "sra", "srta", "senhor", "senhora", "dona", "seu", "pr", "pra", "pastor", "pastora",
]);
export function primeiroNomeDe(nome: unknown): string | null {
  const partes = String(nome ?? "").split(/\s+/);
  for (const bruto of partes) {
    const p = bruto.replace(/[^\p{L}'-]/gu, "");
    if (p.length < 2) continue;
    if (TITULOS_NOME.has(p.toLowerCase())) continue;
    return p;
  }
  return null;
}
