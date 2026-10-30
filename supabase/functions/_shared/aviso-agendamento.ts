// Aviso para a equipe quando a IA agenda: vai pelo WhatsApp do numero da clinica
// para o celular de quem confirma com o lead (crm_ia_config.aviso_agendamento_whatsapp,
// um ou mais numeros separados por virgula). Vazio = nao avisa.
// Esses numeros tambem contam como "da casa" no webhook: o eco do aviso nunca
// vira card de lead. Logica pura (sem banco) para ser testavel.

import { canonicoTelefone, telefoneBrPlausivel } from "./telefone.ts";
import { partesNoFuso, TZ_PADRAO } from "./horario.ts";

export function numerosAviso(valor: string | null | undefined): string[] {
  const out: string[] = [];
  for (const parte of String(valor || "").split(/[,;\n]/)) {
    const c = canonicoTelefone(parte.trim());
    if (c && telefoneBrPlausivel(c) && !out.includes(c)) out.push(c);
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
  linkCrm?: string | null;
}): string {
  const linhas = [
    a.atualizado ? "🔁 *Agendamento alterado pela IA*" : "📅 *Novo agendamento pela IA*",
    "",
    `*Nome:* ${a.nome || "-"}`,
    `*WhatsApp:* ${telefoneLegivel(a.telefone)}`,
    `*Serviço:* ${a.servico || "-"}`,
    `*Data:* ${dataHoraLocal(a.inicioIso)}`,
  ];
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
