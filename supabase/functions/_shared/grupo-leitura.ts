// Leitura de grupo do WhatsApp (Z-API), SOMENTE LEITURA - SQL 50 (19/11/2026).
//
// Pedido do Fabio: guardar as mensagens do grupo "Treinamento Jully" para
// leitura. Regras rigidas:
//   - nunca enviar nada no grupo (nenhuma funcao daqui envia);
//   - a Jully/IA nao processa nem responde grupo;
//   - grupo nunca vira card de lead/paciente nem dispara aviso;
//   - so grupos de ic_grupos_leitura sao guardados; os demais sao descartados.
//
// Funcoes puras (testadas em grupo-leitura_test.ts). Quem grava e o
// ic-meta-webhook (registrarGrupoLeitura).

import { soDigitos } from "./telefone.ts";

export type MensagemGrupo = {
  grupoId: string;
  grupoNome: string;
  messageId: string;
  autorTelefone: string | null;
  autorNome: string | null;
  deMim: boolean;
  tipo: string;
  texto: string | null;
  midiaUrl: string | null;
  midiaMime: string | null;
  enviadaEm: string; // ISO
};

// O evento da Z-API e de grupo? (isGroup, ou o id do chat com cara de grupo.)
export function ehEventoGrupoZapi(e: any): boolean {
  if (!e || typeof e !== "object") return false;
  if (e.type !== "ReceivedCallback") return false;
  if (e.isGroup === true) return true;
  const phone = String(e.phone || "");
  return phone.endsWith("-group") || phone.includes("@g.us");
}

// Nome comparavel: sem acento, sem espaco duplo, minusculo.
export function normalizarNomeGrupo(nome: unknown): string {
  return String(nome ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function texto(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function url(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch (_e) {
    return null;
  }
}

// Le um ReceivedCallback de grupo. null = sem id de grupo ou de mensagem.
export function extrairMensagemGrupo(e: any): MensagemGrupo | null {
  if (!ehEventoGrupoZapi(e)) return null;
  const grupoId = String(e.phone || "").trim();
  const messageId = String(e.messageId || "").trim();
  if (!grupoId || !messageId) return null;

  const participante = String(e.participantPhone || "").trim();
  const lid = String(e.participantLid || "").trim();
  const autorTelefone = participante ? (soDigitos(participante) || participante) : (lid || null);

  const ms = Number(e.momment);
  const enviadaEm = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString();

  let tipo = "outro";
  let conteudo: string | null = null;
  let midiaUrl: string | null = null;
  let midiaMime: string | null = null;
  if (e.text && typeof e.text === "object") {
    tipo = "texto";
    conteudo = texto(e.text.message);
  } else if (e.audio && typeof e.audio === "object") {
    tipo = "audio";
    midiaUrl = url(e.audio.audioUrl);
    midiaMime = texto(e.audio.mimeType);
  } else if (e.image && typeof e.image === "object") {
    tipo = "imagem";
    conteudo = texto(e.image.caption);
    midiaUrl = url(e.image.imageUrl);
    midiaMime = texto(e.image.mimeType);
  } else if (e.video && typeof e.video === "object") {
    tipo = "video";
    conteudo = texto(e.video.caption);
    midiaUrl = url(e.video.videoUrl);
    midiaMime = texto(e.video.mimeType);
  } else if (e.document && typeof e.document === "object") {
    tipo = "documento";
    conteudo = texto([e.document.fileName ?? e.document.title, e.document.caption].filter(Boolean).join(" - "));
    midiaUrl = url(e.document.documentUrl);
    midiaMime = texto(e.document.mimeType);
  } else if (e.sticker && typeof e.sticker === "object") {
    tipo = "figurinha";
  } else if (e.location && typeof e.location === "object") {
    tipo = "localizacao";
  } else if (e.contact && typeof e.contact === "object") {
    tipo = "contato";
    conteudo = texto(e.contact.displayName);
  } else if (e.reaction && typeof e.reaction === "object") {
    tipo = "reacao";
    conteudo = texto(e.reaction.value);
  } else if (e.poll && typeof e.poll === "object") {
    tipo = "enquete";
    conteudo = texto(e.poll.question);
  }

  return {
    grupoId,
    grupoNome: String(e.chatName || "").trim(),
    messageId,
    autorTelefone,
    autorNome: texto(e.senderName),
    deMim: e.fromMe === true,
    tipo,
    texto: conteudo,
    midiaUrl,
    midiaMime,
    enviadaEm,
  };
}

export type GrupoLido = { id: number; nome: string; grupo_id: string | null };

// Decide se a mensagem e de um grupo lido.
//  - "id": o grupo ja esta vinculado por id -> guardar.
//  - "vincular": ainda sem id e o nome bate EXATAMENTE (normalizado) -> gravar o
//    id na linha (uma vez so) e guardar.
//  - null: descartar.
export function decidirGrupo(
  grupos: GrupoLido[],
  grupoId: string,
  grupoNome: string,
): { acao: "id" | "vincular"; grupo: GrupoLido } | null {
  const porId = grupos.find((g) => g.grupo_id && g.grupo_id === grupoId);
  if (porId) return { acao: "id", grupo: porId };
  const nome = normalizarNomeGrupo(grupoNome);
  if (!nome) return null;
  const porNome = grupos.find((g) => !g.grupo_id && normalizarNomeGrupo(g.nome) === nome);
  return porNome ? { acao: "vincular", grupo: porNome } : null;
}
