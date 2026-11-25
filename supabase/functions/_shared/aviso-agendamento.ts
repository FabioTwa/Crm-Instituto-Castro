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

// Quem recebe o que vai ao time de agendamento (lembretes de pendencias e
// alertas de reclamacao): o numero do time (callcenter_whatsapp) mais as copias
// (time_copia_whatsapp, pedido do Fabio em 25/11/2026). As copias nao entram na
// distribuicao de leads: o paciente continua ouvindo so o numero do time.
export function destinosDoTime(callcenter: string | null | undefined, copias: string | null | undefined): string[] {
  const out = numerosAviso(callcenter);
  for (const n of numerosAviso(copias)) if (!out.includes(n)) out.push(n);
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
// TIME DE AGENDAMENTO (decisao do Fabio, 19/11/2026)
// Com crm_ia_config.modo_pre_agendamento = 'true', a Jully NAO marca horario:
// quando a pessoa quer agendar, ela passa os dados para o time de agendamento
// do Instituto, que marca o dia e o horario com a pessoa por OUTRO numero
// (nunca dois atendendo juntos no numero da Jully: risco de queda).
// O pedido vai para os numeros do aviso de agendamento (aviso_agendamento_whatsapp)
// e para um numero do call center (callcenter_whatsapp, rodizio estavel pelo
// card), quando houver.
// ---------------------------------------------------------------------------

export function modoPreAgendamento(cfg: Record<string, string> | null | undefined): boolean {
  return String(cfg?.modo_pre_agendamento ?? "false").trim().toLowerCase() === "true";
}

// Escolhe um numero do call center para o lead. Mesmo card = mesmo numero;
// cards diferentes se espalham.
export function numeroCallCenterDoLead(numeros: readonly string[], chave: string): string | null {
  if (!numeros.length) return null;
  let h = 0;
  for (const ch of String(chave || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return numeros[h % numeros.length];
}

// Para quem vai o pedido de agendamento: numeros do aviso + o numero do call
// center do lead (sem repetir).
export function destinosPedidoAgendamento(avisos: readonly string[], callCenter: string | null): string[] {
  const out = [...avisos];
  if (callCenter && !out.includes(callCenter)) out.push(callCenter);
  return out;
}

// Pedido que chega no WhatsApp do time. Mesma estrutura do aviso de agendamento,
// sem data (quem marca e o time), com o resumo da conversa e o status no fim.
// Sem detalhes clinicos alem do servico procurado (LGPD: o minimo para agendar).
export function textoPedidoAgendamento(a: {
  nome: string;
  telefone: string;
  servico: string;
  formato?: string | null;
  pagamento?: string | null;
  preferencia?: string | null;
  resumo?: string | null;
  observacao?: string | null;
  linkCrm?: string | null;
}): string {
  const linhas = [
    "📅 *Novo pedido de agendamento pela Jully*",
    "",
    `*Nome:* ${a.nome || "-"}`,
    `*WhatsApp:* ${telefoneLegivel(a.telefone)}`,
    `*Serviço:* ${a.servico || "-"}`,
  ];
  if (a.formato) linhas.push(`*Formato:* ${a.formato}`);
  linhas.push(`*Pagamento:* ${a.pagamento || "não informado"}`);
  if (a.preferencia) linhas.push(`*Preferência:* ${a.preferencia}`);
  if (a.resumo) linhas.push(`*Resumo da conversa:* ${a.resumo}`);
  if (a.observacao) linhas.push(`*Obs.:* ${a.observacao}`);
  linhas.push("", "A Jully avisou que o time de agendamento vai entrar em contato para marcar o horário.");
  if (a.linkCrm) linhas.push(`Conversa completa no CRM: ${a.linkCrm}`);
  linhas.push("", "⏳ *Aguardando agendamento*");
  return linhas.join("\n");
}

// Janela em que um novo pedido de agendamento do MESMO card nao vai de novo ao
// time (23/11/2026: a IA chamou solicitar_agendamento duas vezes na mesma
// resposta e os numeros de aviso receberam a mensagem em dobro).
export const MINUTOS_SEM_REPETIR_PEDIDO = 30;

// Decide se o pedido de agendamento vai ao time agora. Nao vai se ja foi nesta
// mesma resposta, nem se o ultimo aviso do card foi ha menos de `janelaMin`.
export function deveAvisarPedido(a: {
  jaAvisouNestaResposta: boolean;
  ultimoAvisoMs: number | null;
  agoraMs: number;
  janelaMin?: number;
}): boolean {
  if (a.jaAvisouNestaResposta) return false;
  if (a.ultimoAvisoMs === null || !Number.isFinite(a.ultimoAvisoMs)) return true;
  const janela = (a.janelaMin ?? MINUTOS_SEM_REPETIR_PEDIDO) * 60000;
  return a.agoraMs - a.ultimoAvisoMs >= janela;
}
