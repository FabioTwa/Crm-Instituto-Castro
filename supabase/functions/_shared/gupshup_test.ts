import { assert, assertEquals } from "jsr:@std/assert";
import {
  baixarMidiaGupshup,
  corpoTemplateGupshup,
  corpoTextoGupshup,
  enviarTextoGupshup,
  envelopeGupshup,
  interpretarRespostaGupshup,
  mensagemV2ParaMeta,
  tokenWebhookValido,
  urlMidiaPermitida,
} from "./gupshup.ts";

// Formatos copiados da documentacao do Gupshup (Inbound messages / Media / Message events).
const v2Texto = {
  app: "IntegracaoCRM",
  timestamp: 1759935600000,
  version: 2,
  type: "message",
  payload: {
    id: "ABEGkYaYVSEEAhAL3SLAWwHKeKrt6s3FKB0c",
    source: "5511978064033",
    type: "text",
    payload: { text: "Oi, quero saber da bariátrica" },
    sender: { phone: "5511978064033", name: "Maria", country_code: "55", dial_code: "11978064033" },
  },
};

const v2Audio = {
  app: "IntegracaoCRM",
  timestamp: 1759935600000,
  version: 2,
  type: "message",
  payload: {
    id: "ABEGkYaYVSEEAhAL3SLAWwHKeKrt6s3FKB0d",
    source: "5511978064033",
    type: "audio",
    payload: {
      url: "https://filemanager.gupshup.io/wa/abc/audio.ogg",
      contentType: "audio/ogg; codecs=opus",
      urlExpiry: 1760022000000,
    },
    sender: { phone: "5511978064033", name: "Maria" },
  },
};

Deno.test("token do webhook: so passa com segredo configurado e igual", () => {
  assert(tokenWebhookValido("abc123", "abc123"));
  assert(!tokenWebhookValido("abc124", "abc123"));
  assert(!tokenWebhookValido("", "abc123"));
  assert(!tokenWebhookValido("abc123", ""));
  assert(!tokenWebhookValido("", ""));
});

Deno.test("v2 texto vira messages[] da Meta, com nome do contato", () => {
  const r = mensagemV2ParaMeta(v2Texto)!;
  assertEquals(r.mensagem.from, "5511978064033");
  assertEquals(r.mensagem.id, "ABEGkYaYVSEEAhAL3SLAWwHKeKrt6s3FKB0c");
  assertEquals(r.mensagem.type, "text");
  assertEquals(r.mensagem.text.body, "Oi, quero saber da bariátrica");
  assertEquals(r.mensagem.timestamp, "1759935600");
  assertEquals(r.contato, { wa_id: "5511978064033", profile: { name: "Maria" } });
});

Deno.test("v2 audio leva o link e o tipo, sem id", () => {
  const r = mensagemV2ParaMeta(v2Audio)!;
  assertEquals(r.mensagem.type, "audio");
  assertEquals(r.mensagem.audio.url, "https://filemanager.gupshup.io/wa/abc/audio.ogg");
  assertEquals(r.mensagem.audio.mime_type, "audio/ogg; codecs=opus");
  assertEquals(r.mensagem.audio.id, "");
});

Deno.test("v2 arquivo vira document com nome; respostas de botao viram interactive/button", () => {
  const base = structuredClone(v2Texto);
  base.payload.type = "file";
  (base.payload as any).payload = { url: "https://filemanager.gupshup.io/x.pdf", name: "exame.pdf", contentType: "application/pdf" };
  const doc = mensagemV2ParaMeta(base)!.mensagem;
  assertEquals(doc.type, "document");
  assertEquals(doc.document.filename, "exame.pdf");

  base.payload.type = "list_reply";
  (base.payload as any).payload = { title: "Manhã", id: "1", reply: "Manhã 1", postbackText: "manha" };
  const lr = mensagemV2ParaMeta(base)!.mensagem;
  assertEquals(lr.type, "interactive");
  assertEquals(lr.interactive.list_reply.title, "Manhã");

  base.payload.type = "quick_reply";
  (base.payload as any).payload = { text: "Sim", payload: "sim" };
  const qr = mensagemV2ParaMeta(base)!.mensagem;
  assertEquals(qr.type, "button");
  assertEquals(qr.button.text, "Sim");
});

Deno.test("v2 sem id ou sem telefone e descartado", () => {
  const semId = structuredClone(v2Texto);
  semId.payload.id = "";
  assertEquals(mensagemV2ParaMeta(semId), null);
  const semFone = structuredClone(v2Texto) as any;
  semFone.payload.source = "";
  semFone.payload.sender = {};
  assertEquals(mensagemV2ParaMeta(semFone), null);
});

Deno.test("envelope v2 de mensagem: formato da Meta, com app e original", () => {
  const { envelope, tipo } = envelopeGupshup(v2Texto);
  assertEquals(tipo, "message");
  assertEquals(envelope._ic_provedor, "gupshup");
  assertEquals(envelope._ic_formato, "v2");
  assertEquals(envelope.gs_app_name, "IntegracaoCRM");
  assertEquals(envelope._ic_original, v2Texto);
  const ch = envelope.entry[0].changes[0];
  assertEquals(ch.field, "messages");
  assertEquals(ch.value.messages.length, 1);
  assertEquals(ch.value.contacts[0].wa_id, "5511978064033");
});

Deno.test("envelope v2 de message-event vira statuses (so log), com codigo da falha", () => {
  const ev = {
    app: "IntegracaoCRM",
    timestamp: 1759935600000,
    version: 2,
    type: "message-event",
    payload: {
      id: "9163a016-710e-41ee-978b-79a1adbd734e",
      gsId: "72f61f22-5aa4-4615-a970-943edf6da01c",
      type: "failed",
      destination: "5511978064033",
      payload: { code: 470, reason: "Message failed to send because more than 24 hours have passed" },
    },
  };
  const { envelope, tipo } = envelopeGupshup(ev);
  assertEquals(tipo, "message-event");
  const v = envelope.entry[0].changes[0].value;
  assertEquals(v.messages, undefined);
  assertEquals(v.statuses[0].status, "failed");
  assertEquals(v.statuses[0].codigo, 470);
  assertEquals(v.statuses[0].gs_id, "72f61f22-5aa4-4615-a970-943edf6da01c");
});

Deno.test("envelope v3 (formato Meta / coexistencia) passa como veio, marcado", () => {
  const v3 = {
    gs_app_id: "app-123",
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA",
      changes: [{
        field: "smb_message_echoes",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5511999990000", phone_number_id: "PNID" },
          message_echoes: [{ from: "5511999990000", to: "5511978064033", id: "wamid.X", timestamp: "1", type: "text", text: { body: "oi" } }],
        },
      }],
    }],
  };
  const { envelope, tipo } = envelopeGupshup(v3);
  assertEquals(tipo, "v3");
  assertEquals(envelope._ic_provedor, "gupshup");
  assertEquals(envelope.gs_app_id, "app-123");
  assertEquals(envelope.entry, v3.entry);
});

Deno.test("evento desconhecido vira envelope vazio, sem quebrar", () => {
  const { envelope, tipo } = envelopeGupshup({ qualquer: 1 });
  assertEquals(tipo, "desconhecido");
  assertEquals(envelope.entry, []);
});

Deno.test("link de midia: so https em host conhecido; chave so vai para o Gupshup", () => {
  assertEquals(urlMidiaPermitida("https://filemanager.gupshup.io/a.ogg"), { ok: true, mandaChave: true });
  assertEquals(urlMidiaPermitida("https://lookaside.fbsbx.com/a"), { ok: true, mandaChave: false });
  assertEquals(urlMidiaPermitida("http://filemanager.gupshup.io/a.ogg").ok, false);
  assertEquals(urlMidiaPermitida("https://gupshup.io.evil.com/a").ok, false);
  assertEquals(urlMidiaPermitida("https://169.254.169.254/latest").ok, false);
  assertEquals(urlMidiaPermitida("nao e url").ok, false);
});

Deno.test("corpo do envio de texto segue a doc (/wa/api/v1/msg)", () => {
  const f = corpoTextoGupshup({ apiKey: "k", app: "IntegracaoCRM", origem: "+55 (11) 99999-0000" }, "5511978064033", "Olá!");
  assertEquals(f.get("channel"), "whatsapp");
  assertEquals(f.get("source"), "5511999990000");
  assertEquals(f.get("destination"), "5511978064033");
  assertEquals(f.get("src.name"), "IntegracaoCRM");
  assertEquals(JSON.parse(f.get("message")!), { type: "text", text: "Olá!" });
  assertEquals(f.get("apikey"), null); // a chave vai no header, nunca no corpo
});

Deno.test("corpo do modelo usa o ID do Gupshup e params como texto", () => {
  const f = corpoTemplateGupshup({ apiKey: "k", app: "A", origem: "5511999990000" }, "5511978064033", { id: "uuid-1", params: ["Maria", 10] });
  assertEquals(JSON.parse(f.get("template")!), { id: "uuid-1", params: ["Maria", "10"] });
});

Deno.test("resposta: so 'submitted' + messageId e sucesso", () => {
  const ok = interpretarRespostaGupshup(202, { status: "submitted", messageId: "ee4a68a0" });
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.wamid, "ee4a68a0");
  const err = interpretarRespostaGupshup(401, { status: "error", message: "Authentication Failed" });
  assert(!err.ok);
  if (!err.ok) {
    assertEquals(err.status, 401);
    assertEquals(err.mensagemMeta, "Authentication Failed");
  }
  assert(!interpretarRespostaGupshup(200, { status: "error", message: "x" }).ok);
  assert(!interpretarRespostaGupshup(200, {}).ok);
});

Deno.test("envio de texto: header apikey, form-urlencoded, le JSON servido como text/html", async () => {
  const original = globalThis.fetch;
  let visto: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    visto = { url, init };
    return Promise.resolve(
      new Response(JSON.stringify({ status: "submitted", messageId: "m-1" }), { status: 200, headers: { "content-type": "text/html" } }),
    );
  }) as typeof fetch;
  try {
    const r = await enviarTextoGupshup({ canal: { apiKey: "CHAVE", app: "A", origem: "5511999990000" }, para: "5511978064033", texto: "oi" });
    assert(r.ok);
    assertEquals(visto!.url, "https://api.gupshup.io/wa/api/v1/msg");
    const h = visto!.init.headers as Record<string, string>;
    assertEquals(h.apikey, "CHAVE");
    assertEquals(h["Content-Type"], "application/x-www-form-urlencoded");
    assert(!String(visto!.init.body).includes("CHAVE"));
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("midia: link do v2 com chave so para gupshup.io; id do v3 vai para wamedia", async () => {
  const original = globalThis.fetch;
  const chamadas: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    chamadas.push({ url, headers: (init?.headers || {}) as Record<string, string> });
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/octet-stream" } }));
  }) as typeof fetch;
  try {
    const a = await baixarMidiaGupshup({ url: "https://filemanager.gupshup.io/a.ogg", apiKey: "K", mimeType: "audio/ogg" });
    assertEquals(a?.bytes.byteLength, 3);
    assertEquals(chamadas[0].headers.apikey, "K");

    await baixarMidiaGupshup({ url: "https://lookaside.fbsbx.com/a", apiKey: "K" });
    assertEquals(chamadas[1].headers.apikey, undefined);

    const b = await baixarMidiaGupshup({ mediaId: "MID 1", app: "IntegracaoCRM", apiKey: "K" });
    assertEquals(chamadas[2].url, "https://api.gupshup.io/sm/api/wamedia/IntegracaoCRM/MID%201");
    assertEquals(b?.mimeType, "audio/ogg"); // octet-stream nao serve: cai no padrao do WhatsApp

    assertEquals(await baixarMidiaGupshup({ url: "https://evil.example/a", apiKey: "K" }), null);
    assertEquals(await baixarMidiaGupshup({ mediaId: "x", app: "A", apiKey: "" }), null);
    assertEquals(chamadas.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});
