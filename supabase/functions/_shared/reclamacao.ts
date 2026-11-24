// Reclamacao de paciente -> alerta no grupo do IC e ao numero do time de
// agendamento (pedido do Fabio, 24/11/2026). A Jully se apresenta, explica o
// caso (motivo, o que aconteceu, nome e telefone) e marca os responsaveis no
// grupo. Este modulo so decide e monta textos: quem grava o alerta e a
// ic-ia-pre-atendimento (SQL 55, ic_alertas_reclamacao) e quem envia e o
// varredor da ic-meta-webhook.
//
// Deteccao por codigo, conservadora (vai para um grupo com o diretor): so frases
// claras de reclamacao. Duvida comum ("vao me responder?") nao conta.
import { normalizarTexto } from "./texto.ts";
import { telefoneLegivel } from "./aviso-agendamento.ts";

export type MotivoReclamacao = "sem_retorno" | "insatisfacao";
export type Reclamacao = { motivo: MotivoReclamacao; termo: string };

// Ninguem respondeu / retornou / ligou.
const RE_SEM_RETORNO = new RegExp(
  "\\b(" + [
    "ninguem (?:me )?(?:responde|respondeu|responder|atende|atendeu|retorna|retornou|ligou|liga|chamou|deu retorno|da retorno|entrou em contato)",
    "nao (?:me )?(?:responderam|respondem|retornaram|retornam|atenderam|atendem|ligaram|chamaram|deram retorno|entraram em contato)",
    "sem (?:nenhuma )?(?:resposta|retorno) (?:ate agora|desde|ha|faz)",
    "(?:ainda )?(?:estou|to|tou|fico) (?:esperando|aguardando) (?:ate agora|desde|ha|faz|(?:o |a |um |uma |algum |alguma )?(?:resposta|retorno|ligacao|contato))",
    "ate agora (?:nada|ninguem|nenhum retorno|nenhuma resposta|sem resposta|sem retorno)",
    "ninguem (?:me )?da (?:atencao|retorno)",
    "nunca (?:me )?(?:respondem|responderam|retornam|retornaram|ligaram)",
  ].join("|") + ")\\b",
);

// Insatisfacao clara com o atendimento.
const RE_INSATISFACAO =
  /\b(quero reclamar|vou reclamar|reclamacao|absurdo|que absurdo|pessimo atendimento|pessimo|pessima|horrivel|procon|reclame aqui|processar|advogad[oa]|insatisfeit[oa]|descaso|falta de respeito|desrespeito|pouco caso|vergonha|decepcionad[oa]|decepcao|palhacada|brincadeira com|enrolando|enrolacao|desorganiza\w*)\b/;

// "nao e reclamacao", "sem reclamacao": nao conta.
const NEGADA = /(?:^|\s)(?:nao (?:e|eh|foi|tenho|quero)|sem|nenhuma?)\s+(?:\w+\s+){0,1}$/;

function achar(t: string, re: RegExp): string | null {
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(t)) !== null) {
    const antes = t.slice(Math.max(0, m.index - 20), m.index);
    if (!NEGADA.test(antes)) return m[0];
    if (m[0].length === 0) g.lastIndex++;
  }
  return null;
}

export function detectarReclamacao(textoOriginal: string): Reclamacao | null {
  const t = normalizarTexto(textoOriginal);
  if (!t) return null;
  const sem = achar(t, RE_SEM_RETORNO);
  if (sem) return { motivo: "sem_retorno", termo: sem };
  const ins = achar(t, RE_INSATISFACAO);
  if (ins) return { motivo: "insatisfacao", termo: ins };
  return null;
}

// Um alerta por paciente nesse intervalo (nao enche o grupo se a pessoa
// reclamar em varias mensagens seguidas).
export const HORAS_ENTRE_ALERTAS = 24;

function diaHora(iso: string, tz = "America/Sao_Paulo"): { dia: string; hora: string } {
  const d = new Date(iso);
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d);
  const h = p.find((x) => x.type === "hour")?.value ?? "00";
  const m = p.find((x) => x.type === "minute")?.value ?? "00";
  return { dia, hora: m === "00" ? `${h}h` : `${h}h${m}` };
}

const STATUS_AGENDAMENTO: Record<string, string> = {
  pendente: "ainda sem confirmação",
  confirmado: "confirmado",
  realizado: "realizado",
  faltou: "paciente faltou",
};

// "O que aconteceu", montado so com o que esta no CRM (nunca inventa).
export function contextoReclamacao(a: {
  pedidoEm: string | null;
  agendamento: { inicio: string; status: string } | null;
  callcenter: string | null;
}): string {
  const partes: string[] = [];
  if (a.pedidoEm) {
    const { dia, hora } = diaHora(a.pedidoEm);
    const canal = a.callcenter ? ` e avisei que o contato seria pelo WhatsApp ${telefoneLegivel(a.callcenter)}` : "";
    partes.push(`Em ${dia}, às ${hora}, eu passei o pedido de agendamento ao time${canal}.`);
  }
  if (a.agendamento) {
    const { dia, hora } = diaHora(a.agendamento.inicio);
    const st = STATUS_AGENDAMENTO[a.agendamento.status] ?? a.agendamento.status;
    partes.push(`No CRM, o horário está marcado para ${dia}, às ${hora} (${st}).`);
  } else if (a.pedidoEm) {
    partes.push("Até agora não há horário marcado no CRM.");
  }
  if (!partes.length) partes.push("O atendimento ainda estava comigo e não havia pedido de agendamento.");
  return partes.join(" ");
}

export function textoAlertaReclamacao(a: {
  nome: string;
  telefone: string;
  mensagem: string;
  motivo: MotivoReclamacao;
  contexto: string;
  recebidaEm: string;
  temPedido: boolean;
  marcar?: string[];
  para: "grupo" | "time";
}): string {
  const { dia, hora } = diaHora(a.recebidaEm);
  const motivo = a.motivo === "sem_retorno"
    ? (a.temPedido ? "falta de retorno do time de agendamento" : "falta de resposta")
    : "insatisfação com o atendimento";
  const msg = String(a.mensagem || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const linhas = [
    a.para === "grupo" ? "Olá, pessoal, tudo bem? 😊" : "Olá, tudo bem? 😊",
    "Aqui é a Jully, a inteligência artificial de atendimento do Instituto Castro.",
    "",
    "⚠️ *Reclamação de paciente*",
    "",
    `*Paciente:* ${String(a.nome || "").trim() || "sem nome no cadastro"}`,
    `*Telefone:* ${telefoneLegivel(a.telefone)}`,
    "",
    `*Motivo da reclamação:* ${motivo}. Mensagem de ${dia}, às ${hora}: "${msg}"`,
    "",
    `*O que aconteceu:* ${a.contexto}`,
    "",
    "Por favor, entrem em contato para entender o que aconteceu. Obrigada!",
  ];
  if (a.marcar && a.marcar.length) linhas.push("", a.marcar.map((n) => "@" + n).join(" "));
  return linhas.join("\n");
}
