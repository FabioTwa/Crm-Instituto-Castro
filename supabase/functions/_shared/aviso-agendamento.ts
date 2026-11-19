// Aviso para a equipe quando a IA agenda: vai pelo WhatsApp do numero da clinica
// para o celular de quem confirma com o lead (crm_ia_config.aviso_agendamento_whatsapp,
// um ou mais numeros separados por virgula). Vazio = nao avisa.
// Esses numeros tambem contam como "da casa" no webhook: o eco do aviso nunca
// vira card de lead. Logica pura (sem banco) para ser testavel.

import { canonicoTelefone, telefonePlausivel } from "./telefone.ts";
import { partesNoFuso, TZ_PADRAO } from "./horario.ts";

export function numerosAviso(valor: string | null | undefined): string[] {
  const out: string[] = [];
  for (const parte of String(valor || "").split(/[,;\n]/)) {
    const c = canonicoTelefone(parte.trim());
    if (c && telefonePlausivel(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export function dataHoraLocal(iso: string, tz: string = TZ_PADRAO): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  const p = partesNoFuso(d, tz);
  const dd = String(p.dia).padStart(2, "0");
  const mm = String(p.mes).padStart(2, "0");
  return `${dd}/${mm} (${DIAS[p.diaSemana]}) às ${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}

// Telefone canonico (5511999998888) -> "(11) 99999-8888".
export function telefoneLegivel(canonico: string): string {
  const d = String(canonico || "").replace(/\D/g, "").replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return canonico || "-";
}

export function textoAvisoAgendamento(a: {
  nome: string;
  telefone: string;
  servico: string;
  inicioIso: string;
  formato?: string | null;
  pagamento?: string | null;
  observacao?: string | null;
  atualizado?: boolean;
  // Remarcacao: horario anterior (o agendamento antigo NAO fica ativo).
  inicioAnteriorIso?: string | null;
  linkCrm?: string | null;
}): string {
  const remarcado = !!a.inicioAnteriorIso && Date.parse(a.inicioAnteriorIso) !== Date.parse(a.inicioIso);
  const linhas = [
    remarcado ? "🔁 *Agendamento remarcado pela IA*" : a.atualizado ? "🔁 *Agendamento alterado pela IA*" : "📅 *Novo agendamento pela IA*",
    "",
    `*Nome:* ${a.nome || "-"}`,
    `*WhatsApp:* ${telefoneLegivel(a.telefone)}`,
    `*Serviço:* ${a.servico || "-"}`,
  ];
  if (remarcado) linhas.push(`*Antes:* ${dataHoraLocal(String(a.inicioAnteriorIso))}`, `*Agora:* ${dataHoraLocal(a.inicioIso)}`);
  else linhas.push(`*Data:* ${dataHoraLocal(a.inicioIso)}`);
  if (a.formato) linhas.push(`*Formato:* ${a.formato}`);
  if (a.pagamento) linhas.push(`*Pagamento:* ${a.pagamento}`);
  if (a.observacao) linhas.push(`*Obs.:* ${a.observacao}`);
  // A central verifica a elegibilidade do convenio depois do agendamento (IC, 30/10/2026).
  if (/conv[eê]nio/i.test(String(a.pagamento || ""))) linhas.push("", "Verificar a elegibilidade do convênio e confirmar a cobertura com o lead.");
  linhas.push("", "Confirme com o lead pelo CRM.");
  if (a.linkCrm) linhas.push(a.linkCrm);
  return linhas.join("\n");
}

// Aviso para a equipe quando a IA cancela um horario a pedido do lead (depois de
// acolher e tentar manter ou remarcar).
export function textoAvisoCancelamento(a: {
  nome: string;
  telefone: string;
  titulo: string;
  inicioIso: string;
  motivo?: string | null;
  linkCrm?: string | null;
}): string {
  const linhas = [
    "❌ *Agendamento cancelado pelo lead*",
    "",
    `*Nome:* ${a.nome || "-"}`,
    `*WhatsApp:* ${telefoneLegivel(a.telefone)}`,
    `*Agendamento:* ${a.titulo || "-"}`,
    `*Data:* ${dataHoraLocal(a.inicioIso)}`,
  ];
  if (a.motivo) linhas.push(`*Motivo:* ${a.motivo}`);
  linhas.push("", "O horário já foi liberado na agenda do CRM.");
  if (a.linkCrm) linhas.push(a.linkCrm);
  return linhas.join("\n");
}

// Pedido que a IA encaminha para a central de agendamento analisar (cirurgia por
// convenio nao atendido ou duvida sobre exames; confirmado pelo IC em 30/10/2026).
export function textoAvisoCentral(a: {
  nome: string;
  telefone: string;
  assunto: string;
  convenio?: string | null;
  procedimento?: string | null;
  resumo?: string | null;
  linkCrm?: string | null;
}): string {
  const titulo = a.assunto === "exames" ? "Dúvida sobre exames" : "Cirurgia por convênio não atendido na clínica";
  const linhas = [
    "📨 *Pedido para a central de agendamento*",
    "",
    `*Assunto:* ${titulo}`,
    `*Nome:* ${a.nome || "-"}`,
    `*WhatsApp:* ${telefoneLegivel(a.telefone)}`,
  ];
  if (a.convenio) linhas.push(`*Convênio/plano:* ${a.convenio}`);
  if (a.procedimento) linhas.push(`*${a.assunto === "exames" ? "Exame" : "Cirurgia"}:* ${a.procedimento}`);
  if (a.resumo) linhas.push(`*Pedido:* ${a.resumo}`);
  linhas.push("", "A IA disse que a central vai analisar, sem garantir cobertura. Retorne para o lead pelo CRM.");
  if (a.linkCrm) linhas.push(a.linkCrm);
  return linhas.join("\n");
}

// ---------------------------------------------------------------------------
// PRE-AGENDAMENTO + CALL CENTER (reuniao com o IC em 19/11/2026)
// Com crm_ia_config.modo_pre_agendamento = 'true', a Jully deixa o horario
// PRE-reservado e passa o lead para o call center do IC, que confirma o
// horario e a cobertura do convenio e fala com o lead por OUTRO numero
// (nunca dois atendendo juntos no numero da Jully: risco de queda).
// crm_ia_config.callcenter_whatsapp: um ou mais numeros, separados por virgula.
// Com mais de um, cada lead vai para um deles (rodizio estavel pelo id do card).
// Vazio: o resumo vai so para os numeros do aviso de agendamento.
// ---------------------------------------------------------------------------

export function modoPreAgendamento(cfg: Record<string, string> | null | undefined): boolean {
  return String(cfg?.modo_pre_agendamento ?? "false").trim().toLowerCase() === "true";
}

// Escolhe um numero do call center para o lead. Mesmo card = mesmo numero
// (remarcacao vai para a mesma pessoa); cards diferentes se espalham.
export function numeroCallCenterDoLead(numeros: readonly string[], chave: string): string | null {
  if (!numeros.length) return null;
  let h = 0;
  for (const ch of String(chave || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return numeros[h % numeros.length];
}

// Resumo que chega no WhatsApp do call center. Sem detalhes clinicos alem do
// servico procurado (LGPD: o minimo para o agendamento).
export function textoAvisoCallCenter(a: {
  nome: string;
  telefone: string;
  servico: string;
  inicioIso: string;
  formato?: string | null;
  pagamento?: string | null;
  resumo?: string | null;
  observacao?: string | null;
  atualizado?: boolean;
  inicioAnteriorIso?: string | null;
  linkCrm?: string | null;
}): string {
  const remarcado = !!a.inicioAnteriorIso && Date.parse(a.inicioAnteriorIso) !== Date.parse(a.inicioIso);
  const linhas = [
    remarcado ? "🔁 *Pré-agendamento alterado pela Jully*" : a.atualizado ? "🔁 *Pré-agendamento alterado pela Jully*" : "📲 *Novo lead pré-agendado pela Jully*",
    "",
    `*Nome:* ${a.nome || "-"}`,
    `*WhatsApp:* ${telefoneLegivel(a.telefone)}`,
    `*Procura:* ${a.servico || "-"}`,
  ];
  if (remarcado) linhas.push(`*Antes:* ${dataHoraLocal(String(a.inicioAnteriorIso))}`, `*Agora (pré-reservado):* ${dataHoraLocal(a.inicioIso)}`);
  else linhas.push(`*Pré-reservado:* ${dataHoraLocal(a.inicioIso)}`);
  if (a.formato) linhas.push(`*Formato:* ${a.formato}`);
  linhas.push(`*Pagamento:* ${a.pagamento || "não informado"}`);
  if (a.resumo) linhas.push(`*Resumo da conversa:* ${a.resumo}`);
  if (a.observacao) linhas.push(`*Obs.:* ${a.observacao}`);
  linhas.push("");
  if (/conv[eê]nio/i.test(String(a.pagamento || ""))) linhas.push("Verificar a elegibilidade do convênio no portal antes de confirmar.");
  linhas.push(
    "A Jully avisou o lead que a equipe de agendamento vai entrar em contato por este número. Chame o lead daqui, confirme o horário na agenda e finalize.",
  );
  if (a.linkCrm) linhas.push("", `Conversa completa no CRM: ${a.linkCrm}`);
  return linhas.join("\n");
}
