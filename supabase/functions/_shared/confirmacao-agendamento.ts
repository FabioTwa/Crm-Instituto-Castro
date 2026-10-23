// Lembrete de confirmacao (TEMPORARIO, decisao do Fabio em 23/10/2026): a IA
// escreve para a pessoa algumas horas antes do horario marcado pedindo que ela
// confirme a presenca. A resposta segue pelo atendimento normal da IA (confirma,
// remarca ou cancela pelas ferramentas que ja existem).
//
//   crm_ia_config.confirmacao_antes_horas  "24" = liga, 24 h antes do horario.
//                                          Vazio, "0" ou sem a chave = DESLIGADO.
//
// Para desligar: update crm_ia_config set valor = '' where chave = 'confirmacao_antes_horas';
// O varredor (1x por minuto) chama; a janela de envio e a mesma das retomadas
// (followup_horario, nunca aos domingos). Logica pura (sem banco) para ser testavel.

import { dataHoraLocal } from "./aviso-agendamento.ts";
import { partesNoFuso, TZ_PADRAO } from "./horario.ts";

export const ETAPA_CONFIRMACAO = "confirmacao_agendamento";
export const STATUS_COM_LEMBRETE = ["pendente", "confirmado"];
// Perto demais do horario o lembrete perde o sentido.
export const MINIMO_ANTES_MS = 2 * 3600 * 1000;
// Tentativas de envio por agendamento (falha do provedor nao vira insistencia).
export const MAX_TENTATIVAS = 3;

export function horasConfirmacao(cfg: Record<string, string>): number {
  const n = Math.floor(Number(String(cfg.confirmacao_antes_horas ?? "").trim() || "0"));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(72, Math.max(3, n));
}

// Quando o lembrete pode sair: "horas" antes do horario; se isso cair num
// domingo, adianta um dia (sabado), porque domingo nao se manda mensagem.
export function inicioDaJanela(inicioMs: number, horas: number, tz: string = TZ_PADRAO): number {
  let ms = inicioMs - horas * 3600 * 1000;
  if (partesNoFuso(new Date(ms), tz).diaSemana === 0) ms -= 24 * 3600 * 1000;
  return ms;
}

// Decide se o agendamento recebe o lembrete agora. So recebe quem marcou com
// antecedencia maior que a janela (quem marcou ontem para hoje acabou de falar
// com a gente) e ainda nao recebeu este lembrete para este horario.
export function precisaLembrete(a: {
  inicio: string;
  criadoEm: string | null;
  status: string | null;
  agora: Date;
  horas: number;
  tentativas: number;
  tz?: string;
}): boolean {
  if (!a.horas) return false;
  if (!STATUS_COM_LEMBRETE.includes(String(a.status || "").toLowerCase())) return false;
  if (a.tentativas >= MAX_TENTATIVAS) return false;
  const inicioMs = Date.parse(a.inicio);
  if (!Number.isFinite(inicioMs)) return false;
  const agoraMs = a.agora.getTime();
  if (inicioMs - agoraMs < MINIMO_ANTES_MS) return false;
  const janela = inicioDaJanela(inicioMs, a.horas, a.tz);
  if (agoraMs < janela) return false;
  const criadoMs = Date.parse(String(a.criadoEm || ""));
  if (Number.isFinite(criadoMs) && criadoMs > janela) return false;
  return true;
}

// "hoje", "amanhã" ou a data, pelo dia local.
function quando(inicioIso: string, agora: Date, tz: string): string {
  const i = partesNoFuso(new Date(inicioIso), tz);
  const hh = `${String(i.hora).padStart(2, "0")}:${String(i.minuto).padStart(2, "0")}`;
  const hoje = partesNoFuso(agora, tz);
  const amanha = partesNoFuso(new Date(agora.getTime() + 24 * 3600 * 1000), tz);
  const mesmoDia = (x: typeof i) => x.ano === i.ano && x.mes === i.mes && x.dia === i.dia;
  const data = dataHoraLocal(inicioIso, tz).replace(/ às \d{2}:\d{2}$/, "");
  if (mesmoDia(hoje)) return `hoje, ${data}, às ${hh}`;
  if (mesmoDia(amanha)) return `amanhã, ${data}, às ${hh}`;
  return `no dia ${data}, às ${hh}`;
}

export function textoConfirmacao(a: { primeiroNome: string | null; inicioIso: string; agora: Date; variante: number; tz?: string }): string {
  const tz = a.tz || TZ_PADRAO;
  const nome = String(a.primeiroNome || "").trim().split(/\s+/)[0] || "";
  const oi = nome ? `Oi, ${nome}! Tudo bem? 😊` : "Oi! Tudo bem? 😊";
  const q = quando(a.inicioIso, a.agora, tz);
  const textos = [
    `${oi}\n\nPassando para lembrar do seu horário aqui no Instituto Castro ${q}. Te esperamos na Av. Paes de Barros, 1378, na Mooca.\n\nPosso confirmar a sua presença?`,
    `${oi}\n\nSó lembrando que o seu horário com a gente é ${q}, aqui na Av. Paes de Barros, 1378, na Mooca.\n\nEstá tudo certo para você vir? Posso confirmar?`,
    `${oi}\n\nEstou passando para confirmar o seu horário aqui no Instituto Castro: ${q}, na Av. Paes de Barros, 1378, na Mooca.\n\nPodemos contar com você?`,
  ];
  const i = Math.abs(Math.floor(a.variante)) % textos.length;
  return textos[Number.isFinite(i) ? i : 0];
}
