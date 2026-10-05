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
