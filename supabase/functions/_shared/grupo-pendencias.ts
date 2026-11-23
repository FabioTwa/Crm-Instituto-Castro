// Pendencias do Instituto no grupo do WhatsApp (SQL 52, 23/11/2026).
//
// Pedido do Fabio: uma vez por dia (seg-sab, a partir das 9h) a Jully manda no
// grupo de leitura ("Treinamento Jully") o que esta esperando o time do
// Instituto: agendamento a confirmar com o paciente e pedido de agendamento sem
// retorno. So assunto do Instituto; nada tecnico vai para o grupo. No grupo
// tambem esta gente de fora do Instituto: so primeiro nome + final do telefone,
// sem dizer o que o paciente quer.
//
// O time responde no proprio grupo ("Diana confirmada", "Andreia agendada", por
// texto ou audio). O CRM casa o nome com a lista de pendencias e marca no CRM
// (agendamento confirmado / card para a etapa de confirmado) e reage com ✅.
// Sem resposta por escrito, para nao encher o grupo.
//
// Logica pura (sem banco), testada em grupo-pendencias_test.ts. Quem le o banco,
// envia e marca e o ic-meta-webhook.

import { normalizarTexto, primeiroNomeDe } from "./texto.ts";
import { partesNoFuso, TZ_PADRAO } from "./horario.ts";

export type TipoPendencia = "confirmar" | "agendar";

export type Pendencia = {
  tipo: TipoPendencia;
  clienteId: string;
  agendamentoId: string | null; // so em "confirmar"
  nome: string; // primeiro nome (ou "Paciente")
  final: string; // 4 ultimos digitos do telefone ("" se nao houver)
  quando: string; // ISO: inicio do agendamento (confirmar) ou do pedido (agendar)
};

// Entrada crua, como sai do banco.
export type CardPendente = {
  id: string;
  nome: string | null;
  telefone: string | null;
  etapa: string | null;
};
export type AgendamentoPendente = { id: string; cliente_crm_id: string; inicio: string };
export type PedidoAberto = { cliente_crm_id: string; criado_em: string };

const ETAPA_AGENDAMENTO_PENDENTE = "agendamento_pendente";
export const MAX_ITENS_POR_LISTA = 15;

function finalTelefone(tel: string | null): string {
  const d = String(tel || "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}

// Dia local (AAAA-MM-DD) de um instante, no fuso da clinica.
export function diaLocal(d: Date, tz: string = TZ_PADRAO): string {
  const p = partesNoFuso(d, tz);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

// Monta a lista do dia.
//  - confirmar: agendamento com status pendente que ainda nao passou;
//  - agendar: pedido de agendamento aberto (handoff) feito ANTES de hoje, com o
//    card ainda em "Agendamento pendente" (se o time ja moveu o card, saiu) e
//    sem agendamento futuro pendente (esse ja entra em "confirmar").
// ignorar: telefones (so digitos) que nunca entram (numeros da casa e de teste).
export function montarPendencias(args: {
  agora: Date;
  cards: CardPendente[];
  agendamentos: AgendamentoPendente[];
  pedidos: PedidoAberto[];
  ignorar?: string[];
  // Para ler a resposta do time: o pedido de hoje tambem pode ser respondido.
  incluirPedidosDeHoje?: boolean;
}): Pendencia[] {
  const hoje = diaLocal(args.agora);
  const ignorar = new Set((args.ignorar || []).map((t) => String(t).replace(/\D/g, "")).filter(Boolean));
  const cardPorId = new Map<string, CardPendente>();
  for (const c of args.cards) {
    const tel = String(c.telefone || "").replace(/\D/g, "");
    if (tel && [...ignorar].some((i) => tel.endsWith(i) || i.endsWith(tel))) continue;
    cardPorId.set(c.id, c);
  }
  const out: Pendencia[] = [];
  const jaListado = new Set<string>();

  const futuros = args.agendamentos
    .filter((a) => new Date(a.inicio).getTime() > args.agora.getTime())
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
  for (const a of futuros) {
    const c = cardPorId.get(a.cliente_crm_id);
    if (!c || jaListado.has(c.id)) continue;
    jaListado.add(c.id);
    out.push({
      tipo: "confirmar",
      clienteId: c.id,
      agendamentoId: a.id,
      nome: primeiroNomeDe(c.nome) || "Paciente",
      final: finalTelefone(c.telefone),
      quando: a.inicio,
    });
  }

  const pedidos = [...args.pedidos].sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  for (const p of pedidos) {
    const c = cardPorId.get(p.cliente_crm_id);
    if (!c || jaListado.has(c.id)) continue;
    if (c.etapa !== ETAPA_AGENDAMENTO_PENDENTE) continue;
    if (!args.incluirPedidosDeHoje && diaLocal(new Date(p.criado_em)) >= hoje) continue;
    jaListado.add(c.id);
    out.push({
      tipo: "agendar",
      clienteId: c.id,
      agendamentoId: null,
      nome: primeiroNomeDe(c.nome) || "Paciente",
      final: finalTelefone(c.telefone),
      quando: p.criado_em,
    });
  }
  return out;
}

const DIAS_CURTOS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function quem(p: Pendencia): string {
  return p.final ? `${p.nome} (final ${p.final})` : p.nome;
}

function diaMes(iso: string): { dm: string; semana: string; hm: string; dia: string } {
  const d = new Date(iso);
  const p = partesNoFuso(d);
  return {
    dm: `${String(p.dia).padStart(2, "0")}/${String(p.mes).padStart(2, "0")}`,
    semana: DIAS_CURTOS[p.diaSemana],
    hm: `${String(p.hora).padStart(2, "0")}h${String(p.minuto).padStart(2, "0")}`,
    dia: diaLocal(d),
  };
}

function linhas(itens: Pendencia[], fmt: (p: Pendencia) => string): string[] {
  const out = itens.slice(0, MAX_ITENS_POR_LISTA).map((p) => "• " + fmt(p));
  if (itens.length > MAX_ITENS_POR_LISTA) out.push(`• e mais ${itens.length - MAX_ITENS_POR_LISTA} no CRM`);
  return out;
}

// Texto da mensagem do dia. null = nada pendente (nao manda nada).
// Numeros marcados (grupo_pendencias_marcar): so digitos, sem repetir.
export function numerosMarcados(valor: string | null | undefined): string[] {
  const out: string[] = [];
  for (const parte of String(valor || "").split(/[,;\s]+/)) {
    let d = parte.replace(/\D/g, "");
    if (d.length === 10 || d.length === 11) d = "55" + d; // DDD + numero, sem o 55
    if (d.length >= 12 && d.length <= 13 && !out.includes(d)) out.push(d);
  }
  return out;
}

// "@5511... @5511..." para o texto; o WhatsApp mostra o nome do contato.
// Recado avulso com este valor sai so com as marcacoes, sem texto.
export const AVULSA_SO_MARCACOES = "so_marcacoes";

// Texto do recado avulso: o recado e, no final, as marcacoes.
export function textoAvulsoGrupo(avulsa: string, marcar: string[]): string | null {
  const recado = String(avulsa || "").trim();
  const partes = recado === AVULSA_SO_MARCACOES ? [] : [recado];
  if (marcar.length) partes.push(textoMarcacoes(marcar));
  const t = partes.filter(Boolean).join("\n\n");
  return t || null;
}
export function textoMarcacoes(marcar: string[]): string {
  return marcar.map((n) => "@" + n).join(" ");
}

// para: "grupo" (mensagem no grupo) ou "time" (conversa direta com o numero do
// time de agendamento, 2020-8098).
export function textoPendenciasGrupo(
  pendencias: Pendencia[], agora: Date, marcar: string[] = [], para: "grupo" | "time" = "grupo",
): string | null {
  if (!pendencias.length) return null;
  const hoje = diaLocal(agora);
  const amanha = diaLocal(new Date(agora.getTime() + 24 * 3600 * 1000));
  const confirmar = pendencias.filter((p) => p.tipo === "confirmar");
  const agendar = pendencias.filter((p) => p.tipo === "agendar");

  const partes: string[] = [
    para === "time" ? "Olá, tudo bem? 😊" : "Olá, pessoal, tudo bem? 😊",
    "Aqui é a Jully, a inteligência artificial de atendimento do Instituto Castro.",
    para === "time"
      ? "Passando para lembrar o que ainda está aguardando retorno no CRM:"
      : "Passando para lembrar o que está aguardando o time:",
  ];
  if (confirmar.length) {
    partes.push("");
    partes.push("*Confirmar o agendamento com o paciente:*");
    partes.push(...linhas(confirmar, (p) => {
      const d = diaMes(p.quando);
      const rotulo = d.dia === hoje ? "hoje" : d.dia === amanha ? "amanhã" : `${d.semana}`;
      return `${quem(p)}: ${rotulo}, ${d.dm}, às ${d.hm}`;
    }));
  }
  if (agendar.length) {
    partes.push("");
    partes.push("*Entrar em contato para agendar:*");
    partes.push(...linhas(agendar, (p) => `${quem(p)}: pediu em ${diaMes(p.quando).dm}`));
  }
  partes.push("");
  partes.push(
    "Quando o paciente estiver confirmado, é só " + (para === "time" ? "me responder" : "responder") +
      " aqui mesmo, por texto ou áudio, " +
      'com o nome e a palavra "confirmada" ou "agendada". Ex.: "Diana confirmada". ' +
      "Eu atualizo no CRM e deixo um ✅ na sua mensagem. Obrigada!",
  );
  // Marcacoes sempre no final (pedido do Fabio, 23/11).
  if (marcar.length) partes.push("", textoMarcacoes(marcar));
  return partes.join("\n");
}

// ---------------------------------------------------------------------------
// Resposta do time no grupo
// ---------------------------------------------------------------------------

// Palavras que dizem que JA foi feito (nao infinitivo: "precisa agendar" nao conta).
const RE_FEITO = new RegExp(
  "\\b(?:" + [
    "confirmad[oa]s?", "confirmou", "confirmei", "confirmamos", "confirmaram",
    "agendad[oa]s?", "agendou", "agendei", "agendamos", "agendaram",
    "marcad[oa]s?", "marcou", "marquei", "marcamos", "marcaram",
    "resolvid[oa]s?", "tudo certo",
  ].join("|") + ")\\b",
);

// Qualquer duvida no trecho: nao mexe.
const RE_DUVIDA = new RegExp(
  "\\b(?:" + [
    "nao", "nem", "sem", "ainda", "aguard\\w*", "esperando", "pendente\\w*",
    "desmarc\\w*", "cancel\\w*", "remarc\\w*", "falt\\w*", "desist\\w*",
    "vou", "vai", "vamos", "vao", "precis\\w*", "tentar", "tentei", "tentamos", "talvez",
  ].join("|") + ")\\b",
);

function escaparRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pendencias citadas no trecho: pelo primeiro nome (palavra inteira) ou pelo
// final do telefone. Nome repetido na lista so vale com o final junto.
function citadas(trecho: string, pendencias: Pendencia[]): Pendencia[] {
  const contagem = new Map<string, number>();
  for (const p of pendencias) {
    const n = normalizarTexto(p.nome);
    contagem.set(n, (contagem.get(n) || 0) + 1);
  }
  const out: Pendencia[] = [];
  for (const p of pendencias) {
    const n = normalizarTexto(p.nome);
    const porFinal = !!p.final && new RegExp(`(?<!\\d)${p.final}(?!\\d)`).test(trecho);
    const porNome = n !== "paciente" && new RegExp(`\\b${escaparRe(n)}\\b`).test(trecho);
    if (porFinal || (porNome && (contagem.get(n) || 0) === 1)) out.push(p);
  }
  return out;
}

// Quais pendencias a mensagem do time da como resolvidas.
// Regra conservadora: a mensagem e quebrada em trechos (. , ; ! ? quebra de
// linha). Se nenhum trecho tem duvida (nao, ainda, vou...), vale a mensagem
// inteira: precisa ter uma palavra de "feito" e os nomes citados. Se algum
// trecho tem duvida, so contam os nomes de trechos com "feito" e sem duvida.
export function interpretarRespostaGrupo(texto: string | null | undefined, pendencias: Pendencia[]): Pendencia[] {
  const t = normalizarTexto(String(texto || ""));
  if (!t || !pendencias.length) return [];
  const trechos = t.split(/[.,;!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const algumaDuvida = trechos.some((s) => RE_DUVIDA.test(s));
  const escolhidas = new Map<string, Pendencia>();
  if (!algumaDuvida) {
    if (!RE_FEITO.test(t)) return [];
    for (const p of citadas(t, pendencias)) escolhidas.set(p.clienteId, p);
  } else {
    const barradas = new Set<string>();
    for (const s of trechos) {
      if (RE_DUVIDA.test(s)) for (const p of citadas(s, pendencias)) barradas.add(p.clienteId);
    }
    for (const s of trechos) {
      if (RE_DUVIDA.test(s) || !RE_FEITO.test(s)) continue;
      for (const p of citadas(s, pendencias)) if (!barradas.has(p.clienteId)) escolhidas.set(p.clienteId, p);
    }
  }
  return [...escolhidas.values()];
}

// Pode mandar a mensagem do dia agora? Seg-sab, a partir da hora configurada e
// antes das 20h (se o cron falhar as 9h, sai na proxima rodada do mesmo dia).
export function horaDoAvisoGrupo(agora: Date, horaInicio: number): boolean {
  const p = partesNoFuso(agora);
  if (p.diaSemana === 0) return false;
  const h = Number.isFinite(horaInicio) ? horaInicio : 9;
  return p.hora >= h && p.hora < 20;
}

// A mensagem diz que algo foi feito (confirmada, agendada...)? Usado para avisar
// o time quando o nome citado nao esta na lista.
export function temPalavraDeFeito(texto: string | null | undefined): boolean {
  return RE_FEITO.test(normalizarTexto(String(texto || "")));
}

export const TEXTO_NAO_ACHEI =
  "Não encontrei esse nome entre as pendências 🤔 Pode me mandar o primeiro nome e o final do telefone? " +
  'Ex.: "Diana 1343 confirmada".';

// Horarios do aviso ao time (time_pendencias_horas, ex. "9,15"). Devolve a
// "vaga" atual (AAAA-MM-DD-H da ultima hora ja passada hoje) ou null fora do
// horario (domingo, antes da primeira hora, das 20h em diante).
export function vagaDoAvisoTime(agora: Date, horasTexto: string | null | undefined): string | null {
  const p = partesNoFuso(agora);
  if (p.diaSemana === 0 || p.hora >= 20) return null;
  const horas = String(horasTexto || "9")
    .split(/[,;\s]+/)
    .map((h) => parseInt(h, 10))
    .filter((h) => Number.isFinite(h) && h >= 0 && h < 20)
    .sort((a, b) => a - b);
  const passadas = horas.filter((h) => h <= p.hora);
  if (!passadas.length) return null;
  return `${diaLocal(agora)}-${passadas[passadas.length - 1]}`;
}
