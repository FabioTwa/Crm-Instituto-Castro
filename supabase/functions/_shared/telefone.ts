// Normalizacao de telefone compartilhada pelas edge functions do IC CRM.
//
// Mesmo codigo usado por ic-meta-webhook e ic-whatsapp-send. E o que segura o
// reconhecimento dos cards antigos.
// NAO MEXER na logica: o webhook e o envio precisam gerar exatamente o mesmo
// numero canonico, senao a trava anti-duplicata por wamid deixa de casar e o
// card do lead nasce em duplicidade.

export function soDigitos(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

// Todas as formas em que o mesmo numero brasileiro pode estar gravado:
// com/sem DDI 55, com/sem o 9 do celular.
export function variacoesTelefone(raw: string): string[] {
  const dig = soDigitos(raw);
  if (!dig) return [];
  const set = new Set<string>();
  set.add(dig);

  let semDDI = dig;
  if ((dig.length === 12 || dig.length === 13) && dig.startsWith("55")) {
    semDDI = dig.slice(2);
  }
  set.add(semDDI);

  if (semDDI.length === 11 && semDDI[2] === "9") {
    const sem9 = semDDI.slice(0, 2) + semDDI.slice(3);
    set.add(sem9);
    set.add("55" + sem9);
  }
  if (semDDI.length === 10) {
    const com9 = semDDI.slice(0, 2) + "9" + semDDI.slice(2);
    set.add(com9);
    set.add("55" + com9);
  }
  if (semDDI.length === 10 || semDDI.length === 11) set.add("55" + semDDI);

  return Array.from(set).filter((v) => v.length >= 8);
}

// Forma canonica: "55" + DDD + 9 + numero (13 digitos para celular).
// E o que vai em clientes_crm.numero_whatsapp e no campo "to" da Cloud API.
export function canonicoTelefone(raw: string): string {
  const dig = soDigitos(raw);
  if (!dig) return "";
  let sem = dig;
  if ((dig.length === 12 || dig.length === 13) && dig.startsWith("55")) sem = dig.slice(2);
  if (sem.length === 10) sem = sem.slice(0, 2) + "9" + sem.slice(2);
  return "55" + sem;
}

// Telefone brasileiro plausivel apos canonicoTelefone: "55" + 10 ou 11 digitos.
export function telefoneBrPlausivel(canonico: string): boolean {
  return /^55\d{10,11}$/.test(String(canonico || ""));
}
