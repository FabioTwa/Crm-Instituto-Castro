// Gupshup (BSP da Meta) como provedor de WhatsApp do IC CRM, no modo
// coexistencia: o numero continua funcionando no WhatsApp Business App do
// celular e o Gupshup entrega as mensagens ao CRM.
//
// Usado por ic-meta-webhook (entrada, rota ?provedor=gupshup) e por
// _shared/whatsapp-envio.ts (saida: ic-whatsapp-send e ic-ia-pre-atendimento).
//
// O que foi conferido na documentacao do Gupshup (docs.gupshup.io, 08/10/2026):
// - Envio de sessao: POST https://api.gupshup.io/wa/api/v1/msg, header apikey,
//   form-urlencoded com channel, source, destination, src.name e message (JSON).
//   Sucesso: 2xx com {"status":"submitted","messageId":"<uuid>"}. O envio e
//   ASSINCRONO: 2xx quer dizer "aceito", nao "entregue". Falha posterior (ex.:
//   fora da janela de 24 h, codigo 470) chega depois, no webhook, como
//   message-event "failed".
// - Modelo: POST https://api.gupshup.io/wa/api/v1/template/msg com source,
//   destination e template={"id":"<uuid do modelo no Gupshup>","params":[...]}.
//   O Gupshup identifica o modelo pelo ID dele, nao pelo nome da Meta.
// - Webhook formato Gupshup (v2): {app, timestamp, version:2, type, payload}.
//   type "message" = mensagem do cliente; midia vem com payload.payload.url
//   (link que expira, campo urlExpiry) e contentType.
// - Webhook formato Meta (v3) e eventos de coexistencia (smb_message_echoes,
//   history...): o Gupshup repassa o envelope da Meta sem mudar nada
//   ({object:"whatsapp_business_account", entry[].changes[]}, mais gs_app_id).
//   Nesse formato a midia vem so com o ID.
// - Midia por ID: GET https://api.gupshup.io/sm/api/wamedia/{app}/{mediaId}
//   com header apikey; devolve o arquivo (application/octet-stream).
//   Fonte: artigo de suporte do Gupshup; conferir em homologacao.
// - Assinatura de webhook: a documentacao do Gupshup NAO descreve nenhuma
//   (nada equivalente ao X-Hub-Signature-256 da Meta). Por isso a autenticidade
//   e garantida por um segredo nosso na propria URL cadastrada no painel
//   (?token=...), comparado em tempo constante. Ver ic-meta-webhook.
//
// Nunca logar a API key nem o corpo inteiro das respostas.

import { iguaisTempoConstante } from "./crypto.ts";
import { soDigitos } from "./telefone.ts";
import type { ResultadoEnvio } from "./whatsapp-cloud.ts";

export const GUPSHUP_API = "https://api.gupshup.io";

// ---------------------------------------------------------------------------
// ENTRADA: autenticidade do webhook
// ---------------------------------------------------------------------------

// true so quando o segredo esta configurado E o token da URL bate.
export function tokenWebhookValido(tokenRecebido: string, segredo: string): boolean {
  if (!segredo || !tokenRecebido) return false;
  return iguaisTempoConstante(tokenRecebido, segredo);
}

// ---------------------------------------------------------------------------
// ENTRADA: formato do webhook
// ---------------------------------------------------------------------------

// Envelope ja no formato da Meta (v3 ou evento de coexistencia).
export function ehEnvelopeMeta(p: any): boolean {
  return !!p && typeof p === "object" && Array.isArray(p.entry);
}

// Evento no formato proprio do Gupshup (v2).
export function ehEventoGupshupV2(p: any): boolean {
  return !!p && typeof p === "object" && typeof p.type === "string" && p.payload != null && !Array.isArray(p.entry);
}

// Converte UMA mensagem v2 do Gupshup para o objeto messages[] da Meta, que e o
// que o ic-meta-webhook ja sabe interpretar. Midia ganha `url` e `mime_type`
// (o id fica vazio: no v2 o arquivo e baixado pelo link).
export function mensagemV2ParaMeta(evento: any): { mensagem: any; contato: any } | null {
  const p = evento && evento.payload;
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").trim();
  const sender = (p.sender && typeof p.sender === "object") ? p.sender : {};
  const from = soDigitos(String(sender.phone || p.source || ""));
  if (!id || !from) return null;

  const tipo = String(p.type || "").toLowerCase();
  const c = (p.payload && typeof p.payload === "object") ? p.payload : {};
  const ts = Number(evento.timestamp);
  const m: any = {
    from,
    id,
    timestamp: Number.isFinite(ts) && ts > 0 ? String(Math.floor(ts / 1000)) : String(Math.floor(Date.now() / 1000)),
  };
  const midia = () => ({
    id: "",
    url: String(c.url || ""),
    mime_type: String(c.contentType || ""),
  });

  switch (tipo) {
    case "text":
      m.type = "text";
      m.text = { body: String(c.text ?? "") };
      break;
    case "image":
      m.type = "image";
      m.image = { ...midia(), caption: String(c.caption ?? "") };
      break;
    case "video":
      m.type = "video";
      m.video = { ...midia(), caption: String(c.caption ?? "") };
      break;
    case "audio":
      m.type = "audio";
      m.audio = midia();
      break;
    case "file":
      m.type = "document";
      m.document = { ...midia(), filename: String(c.name ?? ""), caption: String(c.caption ?? "") };
      break;
    case "sticker":
      m.type = "sticker";
      m.sticker = midia();
      break;
    case "location":
      m.type = "location";
      m.location = { latitude: c.latitude, longitude: c.longitude };
      break;
    case "contact": {
      m.type = "contacts";
      const lista = Array.isArray(c.contacts) ? c.contacts : [];
      m.contacts = lista;
      break;
    }
    case "button_reply":
    case "list_reply":
      m.type = "interactive";
      m.interactive = { [tipo]: { id: String(c.id ?? c.postbackText ?? ""), title: String(c.title ?? c.reply ?? "") } };
      break;
    case "quick_reply":
      m.type = "button";
      m.button = { text: String(c.text ?? ""), payload: String(c.payload ?? "") };
      break;
    default:
      // Tipo que ainda nao conhecemos: o webhook grava "[mensagem não suportada]".
      m.type = tipo || "unknown";
  }
  // Anuncio Click-to-WhatsApp, quando o Gupshup repassar. O webhook so aproveita
  // se vier no formato da Meta (source_type "ad"); senao ignora.
  if (p.referral && typeof p.referral === "object") m.referral = p.referral;

  const nome = String(sender.name || "").trim();
  return { mensagem: m, contato: { wa_id: from, profile: { name: nome } } };
}

// Monta o envelope no formato da Meta a partir de um evento do Gupshup (v2 ou
// v3). `_ic_provedor` e `_ic_original` ficam no envelope gravado em
// crm_entrada_bruta: o varredor reprocessa sabendo de onde veio, e o evento
// cru nunca se perde.
//
// No v2 nao existe phone_number_id: o numero e achado pelo nome do app
// (vendedores_whatsapp.gupshup_app), que vai em metadata.gs_app_name.
export function envelopeGupshup(p: any): { envelope: any; tipo: string } {
  if (ehEnvelopeMeta(p)) {
    return {
      envelope: { ...p, _ic_provedor: "gupshup", _ic_formato: "v3" },
      tipo: "v3",
    };
  }
  if (!ehEventoGupshupV2(p)) {
    return { envelope: { _ic_provedor: "gupshup", _ic_formato: "desconhecido", _ic_original: p, entry: [] }, tipo: "desconhecido" };
  }
  const app = String(p.app || "");
  const base = { _ic_provedor: "gupshup", _ic_formato: "v2", _ic_original: p, gs_app_name: app };
  if (p.type !== "message") {
    // message-event (enqueued/sent/delivered/read/failed), user-event,
    // system-event, billing-event: viram "statuses" e o webhook so registra.
    const pl = p.payload || {};
    return {
      envelope: {
        ...base,
        entry: [{
          changes: [{
            field: "messages",
            value: {
              metadata: { gs_app_name: app },
              statuses: [{
                gs_evento: String(p.type),
                status: String(pl.type || p.type),
                id: String(pl.id || ""),
                gs_id: String(pl.gsId || ""),
                codigo: pl.payload && pl.payload.code != null ? pl.payload.code : null,
                motivo: pl.payload && pl.payload.reason ? String(pl.payload.reason).slice(0, 300) : null,
              }],
            },
          }],
        }],
      },
      tipo: String(p.type),
    };
  }
  const conv = mensagemV2ParaMeta(p);
  return {
    envelope: {
      ...base,
      entry: [{
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { gs_app_name: app },
            contacts: conv ? [conv.contato] : [],
            messages: conv ? [conv.mensagem] : [],
          },
        }],
      }],
    },
    tipo: "message",
  };
}

// ---------------------------------------------------------------------------
// MIDIA
// ---------------------------------------------------------------------------

// Hosts de onde aceitamos baixar o link de midia do v2. A API key so e mandada
// para o proprio Gupshup. Link fora da lista e ignorado (evita o webhook virar
// porta para buscar URL arbitraria).
const HOSTS_MIDIA = ["gupshup.io", "fbsbx.com", "whatsapp.net", "fbcdn.net"];
const MAX_MIDIA_BYTES = 25 * 1024 * 1024; // limite de arquivo da transcricao (Groq)

function hostPermitido(host: string, dominios: string[]): boolean {
  const h = host.toLowerCase();
  return dominios.some((d) => h === d || h.endsWith("." + d));
}

export function urlMidiaPermitida(url: string): { ok: boolean; mandaChave: boolean } {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return { ok: false, mandaChave: false };
    if (!hostPermitido(u.hostname, HOSTS_MIDIA)) return { ok: false, mandaChave: false };
    return { ok: true, mandaChave: hostPermitido(u.hostname, ["gupshup.io"]) };
  } catch (_e) {
    return { ok: false, mandaChave: false };
  }
}

// Baixa a midia: pelo link (v2) ou pelo ID (v3/coexistencia). Falha suave:
// devolve null e o webhook grava o texto substituto.
export async function baixarMidiaGupshup(args: {
  url?: string;
  mediaId?: string;
  app?: string;
  mimeType?: string;
  apiKey: string;
  prefixoLog?: string;
}): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  const LOG = args.prefixoLog || "[gupshup]";
  let alvo = "";
  let headers: Record<string, string> = {};
  if (args.url) {
    const chk = urlMidiaPermitida(args.url);
    if (!chk.ok) {
      console.warn(LOG, "link de midia fora da lista de hosts; ignorado");
      return null;
    }
    alvo = args.url;
    if (chk.mandaChave && args.apiKey) headers = { apikey: args.apiKey };
  } else if (args.mediaId && args.app) {
    if (!args.apiKey) {
      console.warn(LOG, "GUPSHUP_API_KEY ausente; midia gravada como placeholder");
      return null;
    }
    alvo = `${GUPSHUP_API}/sm/api/wamedia/${encodeURIComponent(args.app)}/${encodeURIComponent(args.mediaId)}`;
    headers = { apikey: args.apiKey };
  } else {
    return null;
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(alvo, { headers, signal: ctl.signal });
    if (!r.ok) {
      console.error(LOG, "download de midia falhou:", r.status);
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
    const mimeType = args.mimeType || (ct && !ct.includes("octet-stream") ? ct : "") || "audio/ogg";
    return { bytes, mimeType };
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

export type CanalGupshup = {
  apiKey: string;
  app: string; // src.name: nome do app no painel do Gupshup
  origem: string; // numero do WhatsApp conectado, so digitos com DDI
};

// Corpo form-urlencoded do envio de texto (exportado para teste).
export function corpoTextoGupshup(canal: CanalGupshup, para: string, texto: string): URLSearchParams {
  const f = new URLSearchParams();
  f.set("channel", "whatsapp");
  f.set("source", soDigitos(canal.origem));
  f.set("destination", soDigitos(para));
  f.set("src.name", canal.app);
  f.set("message", JSON.stringify({ type: "text", text: texto }));
  f.set("disablePreview", "true");
  return f;
}

export function corpoTemplateGupshup(
  canal: CanalGupshup,
  para: string,
  template: { id: string; params?: unknown[] },
): URLSearchParams {
  const f = new URLSearchParams();
  f.set("channel", "whatsapp");
  f.set("source", soDigitos(canal.origem));
  f.set("destination", soDigitos(para));
  f.set("src.name", canal.app);
  f.set(
    "template",
    JSON.stringify({ id: template.id, params: Array.isArray(template.params) ? template.params.map((x) => String(x)) : [] }),
  );
  return f;
}

// Le a resposta do Gupshup. Sucesso so com 2xx + status "submitted" + messageId.
export function interpretarRespostaGupshup(status: number, data: any): ResultadoEnvio {
  const messageId = data && data.messageId ? String(data.messageId) : "";
  const st = data && data.status ? String(data.status).toLowerCase() : "";
  if (status >= 200 && status < 300 && messageId && st === "submitted") {
    return { ok: true, wamid: messageId, resposta: { status: st, messageId } };
  }
  const msg = String((data && (data.message || data.reason || (data.error && data.error.message))) || `Gupshup devolveu ${status}`);
  return {
    ok: false,
    status,
    codigoMeta: null,
    mensagemMeta: msg,
    foraDaJanela24h: false,
    resposta: { status: st || null, message: msg.slice(0, 300) },
  };
}

async function postGupshup(
  caminho: string,
  apiKey: string,
  corpo: URLSearchParams,
  prefixoLog: string,
): Promise<ResultadoEnvio> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  let resp: Response;
  let data: any = {};
  try {
    resp = await fetch(`${GUPSHUP_API}${caminho}`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: corpo.toString(),
      signal: ctl.signal,
    });
    // O Gupshup responde JSON com Content-Type text/html: le como texto.
    const txt = await resp.text().catch(() => "");
    try {
      data = JSON.parse(txt);
    } catch (_e) {
      data = { message: txt.slice(0, 300) };
    }
  } catch (e) {
    console.error(prefixoLog, "fetch Gupshup falhou:", e instanceof Error ? e.message : e);
    return { ok: false, status: 0, codigoMeta: null, mensagemMeta: "falha de conexao", foraDaJanela24h: false, resposta: null };
  } finally {
    clearTimeout(t);
  }
  const r = interpretarRespostaGupshup(resp.status, data);
  if (!r.ok) console.error(prefixoLog, "Gupshup nao aceitou o envio:", resp.status, r.mensagemMeta.slice(0, 300));
  return r;
}

export async function enviarTextoGupshup(args: {
  canal: CanalGupshup;
  para: string;
  texto: string;
  prefixoLog?: string;
}): Promise<ResultadoEnvio> {
  return await postGupshup(
    "/wa/api/v1/msg",
    args.canal.apiKey,
    corpoTextoGupshup(args.canal, args.para, args.texto),
    args.prefixoLog || "[gupshup]",
  );
}

export async function enviarTemplateGupshup(args: {
  canal: CanalGupshup;
  para: string;
  template: { id: string; params?: unknown[] };
  prefixoLog?: string;
}): Promise<ResultadoEnvio> {
  return await postGupshup(
    "/wa/api/v1/template/msg",
    args.canal.apiKey,
    corpoTemplateGupshup(args.canal, args.para, args.template),
    args.prefixoLog || "[gupshup]",
  );
}
