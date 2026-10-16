// Z-API como provedor de WhatsApp do IC CRM, para a FASE DE TREINO da IA
// enquanto a conta do Gupshup aguarda a verificacao da Meta (15/10/2026).
//
// ATENCAO: a Z-API NAO e API oficial da Meta. Ela conecta o numero como um
// "aparelho conectado" (WhatsApp Web). Existe risco de banimento do numero.
// Uso decidido pelo Fabio so para treinar a IA; producao continua no Gupshup.
//
// Usado por ic-meta-webhook (entrada, rota ?provedor=zapi) e por
// _shared/whatsapp-envio.ts (saida: ic-whatsapp-send e ic-ia-pre-atendimento).
//
// O que foi conferido na documentacao da Z-API (developer.z-api.io, 15/10/2026):
// - Envio de texto: POST https://api.z-api.io/instances/{instanceId}/token/{token}/send-text
//   com JSON {phone, message} e header Client-Token (token de seguranca da
//   conta, aba Seguranca do painel). Sucesso: 200 com {zaapId, messageId, id}.
//   O messageId e o MESMO que volta no webhook; por isso vai em zapi_message_id.
// - Webhook "Ao receber": JSON plano com type "ReceivedCallback", instanceId,
//   messageId, phone (o lead), connectedPhone (o numero da casa), fromMe,
//   fromApi, isGroup, isNewsletter, broadcast, senderName, momment (ms) e um
//   objeto por tipo: text.message, audio.audioUrl, image.imageUrl/caption...
// - A midia vem com link direto (sem chave).
// - Assinatura de webhook: a documentacao nao descreve nenhuma. A autenticidade
//   e um segredo nosso na URL (?token=ZAPI_WEBHOOK_TOKEN), como no Gupshup.
// - Nao existe mensagem-modelo (template): fora da janela, a Z-API manda texto
//   livre mesmo. O CRM recusa modelo nesse provedor.
//
// Nunca logar tokens nem o corpo inteiro das respostas.

import { iguaisTempoConstante } from "./crypto.ts";
import { soDigitos } from "./telefone.ts";
import type { ResultadoEnvio } from "./whatsapp-cloud.ts";

export const ZAPI_API = "https://api.z-api.io";

// ---------------------------------------------------------------------------
// ENTRADA
// ---------------------------------------------------------------------------

export function tokenWebhookZapiValido(tokenRecebido: string, segredo: string): boolean {
  if (!segredo || !tokenRecebido) return false;
  return iguaisTempoConstante(tokenRecebido, segredo);
}

// Telefone do lead como a Z-API manda: digitos, ou um identificador "...@lid"
// quando o WhatsApp esconde o numero. O @lid passa como esta (o webhook trata).
function telefoneZapi(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.includes("@lid")) return s;
  return soDigitos(s);
}

// Converte UM evento ReceivedCallback para o objeto messages[] da Meta, que e o
// que o ic-meta-webhook ja sabe interpretar. Midia ganha `url` e `mime_type`
// (id vazio: o arquivo e baixado pelo link).
export function mensagemZapiParaMeta(e: any): any | null {
  const id = String(e?.messageId || "").trim();
  const lead = telefoneZapi(e?.phone);
  const casa = soDigitos(String(e?.connectedPhone || ""));
  if (!id || !lead) return null;

  const ms = Number(e.momment);
  const m: any = {
    id,
    timestamp: String(Math.floor((Number.isFinite(ms) && ms > 0 ? ms : Date.now()) / 1000)),
  };
  // Igual a Meta: na recebida o lead esta em "from"; no eco (fromMe) a casa
  // esta em "from" e o lead em "to".
  if (e.fromMe === true) {
    m.from = casa;
    m.to = lead;
  } else {
    m.from = lead;
  }

  const midia = (url: unknown, mime: unknown) => ({ id: "", url: String(url || ""), mime_type: String(mime || "") });

  if (e.text && typeof e.text === "object") {
    m.type = "text";
    m.text = { body: String(e.text.message ?? "") };
  } else if (e.audio && typeof e.audio === "object") {
    m.type = "audio";
    m.audio = midia(e.audio.audioUrl, e.audio.mimeType);
  } else if (e.image && typeof e.image === "object") {
    m.type = "image";
    m.image = { ...midia(e.image.imageUrl, e.image.mimeType), caption: String(e.image.caption ?? "") };
  } else if (e.video && typeof e.video === "object") {
    m.type = "video";
    m.video = { ...midia(e.video.videoUrl, e.video.mimeType), caption: String(e.video.caption ?? "") };
  } else if (e.document && typeof e.document === "object") {
    m.type = "document";
    m.document = {
      ...midia(e.document.documentUrl, e.document.mimeType),
      filename: String(e.document.fileName ?? e.document.title ?? ""),
      caption: String(e.document.caption ?? ""),
    };
  } else if (e.sticker && typeof e.sticker === "object") {
    m.type = "sticker";
    m.sticker = midia(e.sticker.stickerUrl, e.sticker.mimeType);
  } else if (e.location && typeof e.location === "object") {
    m.type = "location";
    m.location = { latitude: e.location.latitude, longitude: e.location.longitude };
  } else if (e.contact && typeof e.contact === "object") {
    m.type = "contacts";
    m.contacts = [{ name: { formatted_name: String(e.contact.displayName ?? "") } }];
  } else if (e.reaction && typeof e.reaction === "object") {
    m.type = "reaction";
    m.reaction = { emoji: String(e.reaction.value ?? "") };
  } else if (e.buttonsResponseMessage && typeof e.buttonsResponseMessage === "object") {
    m.type = "button";
    m.button = { text: String(e.buttonsResponseMessage.message ?? ""), payload: String(e.buttonsResponseMessage.buttonId ?? "") };
  } else if (e.listResponseMessage && typeof e.listResponseMessage === "object") {
    m.type = "interactive";
    m.interactive = {
      list_reply: {
        id: String(e.listResponseMessage.selectedRowId ?? ""),
        title: String(e.listResponseMessage.message ?? e.listResponseMessage.title ?? ""),
      },
    };
  } else {
    // Tipo que ainda nao conhecemos: o webhook grava "[mensagem não suportada]".
    m.type = "unknown";
  }
  return m;
}

// Por que um evento NAO vira mensagem no CRM (null = vira).
export function motivoIgnorarZapi(e: any): string | null {
  if (!e || typeof e !== "object") return "payload invalido";
  if (e.type !== "ReceivedCallback") return "evento " + String(e.type || "sem tipo");
  if (e.isGroup === true) return "grupo";
  if (e.isNewsletter === true) return "canal";
  if (e.broadcast === true) return "lista de transmissao";
  if (e.isStatusReply === true) return "resposta a status";
  if (String(e.phone || "").includes("@g.us") || String(e.phone || "").includes("@newsletter")) return "grupo";
  // Mensagem ainda nao decifrada pelo aparelho: vem sem conteudo.
  if (e.waitingMessage === true) return "aguardando mensagem";
  // Enviada pela API (CRM ou IA). Quem enviou ja gravou a conversa; tratar o
  // eco como "vendedor respondeu pelo celular" faria a IA achar que um humano
  // assumiu e parar de responder.
  if (e.fromMe === true && e.fromApi === true) return "enviada pela api";
  return null;
}

// Monta o envelope no formato da Meta. `_ic_provedor`, `zapi_instance_id` e
// `_ic_original` ficam no envelope gravado em crm_entrada_bruta: o varredor
// reprocessa sabendo de onde veio, e o evento cru nunca se perde.
export function envelopeZapi(e: any): { envelope: any; tipo: string } {
  const instancia = String((e && e.instanceId) || "");
  const casa = soDigitos(String((e && e.connectedPhone) || ""));
  const base = { _ic_provedor: "zapi", _ic_original: e, zapi_instance_id: instancia };
  const motivo = motivoIgnorarZapi(e);
  if (motivo) return { envelope: { ...base, _ic_ignorado: motivo, entry: [] }, tipo: motivo };
  const m = mensagemZapiParaMeta(e);
  if (!m) return { envelope: { ...base, _ic_ignorado: "sem id ou telefone", entry: [] }, tipo: "invalido" };
  const eco = e.fromMe === true;
  const nome = eco ? "" : String(e.senderName || e.chatName || "").trim();
  const value: any = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: casa, zapi_instance_id: instancia },
  };
  if (eco) {
    value.message_echoes = [m];
  } else {
    value.contacts = [{ wa_id: m.from, profile: { name: nome } }];
    value.messages = [m];
  }
  return {
    envelope: { ...base, entry: [{ changes: [{ field: eco ? "smb_message_echoes" : "messages", value }] }] },
    tipo: eco ? "eco" : "mensagem",
  };
}

// ---------------------------------------------------------------------------
// MIDIA
// ---------------------------------------------------------------------------

const MAX_MIDIA_BYTES = 25 * 1024 * 1024; // limite de arquivo da transcricao (Groq)

// So https. Nenhuma credencial e mandada no download, e a rota so chega aqui
// depois do token do webhook conferido.
export function urlMidiaZapiPermitida(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch (_e) {
    return false;
  }
}

export async function baixarMidiaZapi(args: {
  url: string;
  mimeType?: string;
  prefixoLog?: string;
}): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  const LOG = args.prefixoLog || "[zapi]";
  if (!args.url || !urlMidiaZapiPermitida(args.url)) {
    console.warn(LOG, "link de midia ausente ou nao-https; ignorado");
    return null;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(args.url, { signal: ctl.signal });
    if (!r.ok) {
      console.error(LOG, "download de midia falhou:", r.status, new URL(args.url).hostname);
      await r.body?.cancel();
      return null;
    }
    const tam = Number(r.headers.get("content-length") || "0");
    if (tam > MAX_MIDIA_BYTES) {
      console.warn(LOG, "midia grande demais, ignorada:", tam);
      await r.body?.cancel();
      return null;
    }
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MIDIA_BYTES) return null;
    const ct = r.headers.get("content-type") || "";
    // "audio/ogg; codecs=opus" -> "audio/ogg" (o Groq decide pelo tipo base).
    const mime = (args.mimeType || (ct && !ct.includes("octet-stream") ? ct : "") || "audio/ogg").split(";")[0].trim();
    return { bytes, mimeType: mime };
  } catch (e) {
    console.error(LOG, "excecao no download de midia:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// SAIDA: envio
// ---------------------------------------------------------------------------

export type CanalZapi = {
  instancia: string; // ID da instancia (painel Z-API -> Instancias)
  token: string; // token da instancia (segredo ZAPI_INSTANCE_TOKEN)
  clientToken: string; // token de seguranca da conta (segredo ZAPI_CLIENT_TOKEN)
};

export function urlEnvioTextoZapi(canal: CanalZapi): string {
  return `${ZAPI_API}/instances/${encodeURIComponent(canal.instancia)}/token/${encodeURIComponent(canal.token)}/send-text`;
}

export function corpoTextoZapi(
  para: string,
  texto: string,
  delayTyping?: number,
): { phone: string; message: string; delayTyping?: number } {
  const corpo: { phone: string; message: string; delayTyping?: number } = { phone: soDigitos(para), message: texto };
  if (delayTyping && delayTyping > 0) corpo.delayTyping = delayTyping;
  return corpo;
}

// Segundos de "digitando..." antes de a Z-API entregar a mensagem: cresce com o
// tamanho do texto, como alguem digitando de verdade, entre 2 e 9 segundos.
export function segundosDigitando(texto: string): number {
  const s = 1.5 + String(texto || "").length / 28;
  return Math.min(9, Math.max(2, Math.round(s)));
}

// Sucesso so com 2xx + messageId.
export function interpretarRespostaZapi(status: number, data: any): ResultadoEnvio {
  const messageId = data && (data.messageId || data.id) ? String(data.messageId || data.id) : "";
  if (status >= 200 && status < 300 && messageId) {
    return { ok: true, wamid: messageId, resposta: { zaapId: data.zaapId ?? null, messageId } };
  }
  const msg = String((data && (data.error || data.message)) || `Z-API devolveu ${status}`);
  return {
    ok: false,
    status,
    codigoMeta: null,
    mensagemMeta: msg,
    foraDaJanela24h: false,
    resposta: { message: msg.slice(0, 300) },
  };
}

export async function enviarTextoZapi(args: {
  canal: CanalZapi;
  para: string;
  texto: string;
  prefixoLog?: string;
  delayTyping?: number; // segundos de "digitando..." (Z-API segura a entrega)
}): Promise<ResultadoEnvio> {
  const LOG = args.prefixoLog || "[zapi]";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000 + (args.delayTyping || 0) * 1000);
  let resp: Response;
  let data: any = {};
  try {
    resp = await fetch(urlEnvioTextoZapi(args.canal), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": args.canal.clientToken },
      body: JSON.stringify(corpoTextoZapi(args.para, args.texto, args.delayTyping)),
      signal: ctl.signal,
    });
    const txt = await resp.text().catch(() => "");
    try {
      data = JSON.parse(txt);
    } catch (_e) {
      data = { message: txt.slice(0, 300) };
    }
  } catch (e) {
    console.error(LOG, "fetch Z-API falhou:", e instanceof Error ? e.message : e);
    return { ok: false, status: 0, codigoMeta: null, mensagemMeta: "falha de conexao", foraDaJanela24h: false, resposta: null };
  } finally {
    clearTimeout(t);
  }
  const r = interpretarRespostaZapi(resp.status, data);
  if (!r.ok) console.error(LOG, "Z-API nao aceitou o envio:", resp.status, r.mensagemMeta.slice(0, 300));
  return r;
}
