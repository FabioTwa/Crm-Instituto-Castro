// Follow-up (opcional): quando o lead para de responder, a IA retoma o assunto
// algumas vezes, com espacos cada vez maiores (crm_ia_config):
//
//   followups_minutos  minutos desde que a conversa parou (ultima mensagem da IA
//                      que nao e follow-up) para cada retomada, separados por
//                      virgula, ex.: "120,1440,4320" (2 h, 1 dia, 3 dias).
//                      DESLIGADO por padrao (decisao de 21/10/2026: lead que nao
//                      responde nao recebe retorno). Vazio, "0" ou sem a chave = desligado.
//   followup_horario   janela local em que pode mandar, "HH:MM-HH:MM".
//                      Padrao "08:00-20:00". Nunca aos domingos.
//
// Depois da ultima retomada a IA fica quieta ate o lead voltar a escrever.
// Logica pura (sem banco) para ser testavel.

import { partesNoFuso, TZ_PADRAO } from "./horario.ts";

export const FOLLOWUPS_SUGERIDOS = [120, 1440, 4320];
export const FOLLOWUP_HORARIO_PADRAO = "08:00-20:00";

export function followupsDoConfig(cfg: Record<string, string>): number[] {
  const bruto = cfg.followups_minutos;
  if (bruto == null) return [];
  const lista = String(bruto)
    .split(",")
    .map((s) => Math.floor(Number(s.trim())))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.min(20160, Math.max(30, n)));
  return [...new Set(lista)].sort((a, b) => a - b);
}

function minutosDe(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function podeMandarFollowup(agoraUTC: Date, horario: string | null | undefined, tz: string = TZ_PADRAO): boolean {
  const [ini, fim] = String(horario || FOLLOWUP_HORARIO_PADRAO).split("-");
  const a = minutosDe(ini) ?? 8 * 60;
  const b = minutosDe(fim) ?? 20 * 60;
  const p = partesNoFuso(agoraUTC, tz);
  if (p.diaSemana === 0) return false;
  const agora = p.hora * 60 + p.minuto;
  return agora >= a && agora < b;
}

export type MensagemRecente = { autor: string | null; criada_em: string; payload_raw?: Record<string, unknown> | null };

export function ehFollowup(m: MensagemRecente): boolean {
  return m.autor === "ia" && !!m.payload_raw && (m.payload_raw as any).followup === true;
}

// recentes: mensagens do card, da MAIS NOVA para a mais antiga.
// Devolve qual retomada mandar agora (1, 2, 3...) ou null.
// So retoma quando quem falou por ultimo foi a IA (fora os proprios follow-ups):
// lead ou vendedor por ultimo = conversa viva ou com a equipe.
export function decidirFollowup(a: {
  recentes: readonly MensagemRecente[];
  agora: Date;
  minutos: readonly number[];
}): { numero: number; parado_min: number } | null {
  if (!a.minutos.length) return null;
  let enviados = 0;
  let base: MensagemRecente | null = null;
  for (const m of a.recentes) {
    if (ehFollowup(m)) {
      enviados++;
      continue;
    }
    base = m;
    break;
  }
  if (!base || base.autor !== "ia") return null;
  if (base.payload_raw && (base.payload_raw as any).encerramento === true) return null;
  if (enviados >= a.minutos.length) return null;
  const baseMs = Date.parse(base.criada_em);
  if (!Number.isFinite(baseMs)) return null;
  const parado = Math.floor((a.agora.getTime() - baseMs) / 60000);
  if (parado < a.minutos[enviados]) return null;
  return { numero: enviados + 1, parado_min: parado };
}

// Instrucao interna que vai como ultima fala para a IA escrever a retomada.
// Nao e mensagem do lead; a IA responde so com o texto da retomada.
export function instrucaoFollowup(numero: number, total: number, paradoMin: number): string {
  const tempo = paradoMin >= 1440 ? `${Math.round(paradoMin / 1440)} dia(s)` : `${Math.max(1, Math.round(paradoMin / 60))} hora(s)`;
  const ultima = numero >= total;
  return (
    `[Aviso interno do sistema, não é mensagem da pessoa: ela não responde há cerca de ${tempo}. ` +
    `Escreva UMA mensagem curta (1 ou 2 frases) para retomar a conversa de onde ela parou, de forma leve e acolhedora, ` +
    `retomando o último assunto (por exemplo, o horário que ficou em aberto ou a dúvida que ela tinha). ` +
    `Não repita frases que você já mandou, não cobre resposta e não diga que ela sumiu. ` +
    (ultima
      ? `Esta é a última tentativa: deixe claro, com carinho, que ela pode chamar quando quiser, sem pressão. `
      : `Termine com uma pergunta simples. `) +
    `Não use ferramentas.]`
  );
}

// Se a IA falhar ou a pos-validacao barrar, vai um destes (revisados, sem termos bloqueados).
export const TEXTOS_FOLLOWUP: readonly (readonly string[])[] = [
  [
    "Oi! Conseguiu pensar no melhor dia pra sua consulta? Se quiser, já te passo os horários livres 😊",
    "Oi, tudo bem? Fiquei aqui com o seu atendimento em aberto. Quer que eu veja um horário pra você?",
  ],
  [
    "Oi! Passando pra saber se ainda posso te ajudar com o agendamento. Me conta o que ficou melhor pra você?",
    "Oi, tudo bem? Se ainda tiver alguma dúvida sobre a consulta, me chama que eu te ajudo por aqui.",
  ],
  [
    "Oi! Vou deixar o seu atendimento por aqui, tá bom? Quando quiser marcar, é só me chamar 😊",
    "Oi! Qualquer hora que quiser retomar, é só mandar uma mensagem por aqui que eu te ajudo 😊",
  ],
];

export function textoFollowupFixo(numero: number, aleatorio: () => number = Math.random): string {
  const grupo = TEXTOS_FOLLOWUP[Math.min(Math.max(numero, 1), TEXTOS_FOLLOWUP.length) - 1];
  return grupo[Math.min(grupo.length - 1, Math.floor(aleatorio() * grupo.length))];
}
