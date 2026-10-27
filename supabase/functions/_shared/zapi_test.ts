import { assert, assertEquals } from "jsr:@std/assert";
import {
  corpoTextoZapi,
  segundosDigitando,
  envelopeZapi,
  interpretarRespostaZapi,
  mensagemZapiParaMeta,
  motivoIgnorarZapi,
  tokenWebhookZapiValido,
  urlEnvioTextoZapi,
  urlMidiaZapiPermitida,
} from "./zapi.ts";

// Formato do exemplo "Ao receber" da documentacao da Z-API.
const base = {
  isStatusReply: false,
  connectedPhone: "5511916863913",
  waitingMessage: false,
  isEdit: false,
  isGroup: false,
  isNewsletter: false,
  instanceId: "INST1",
  messageId: "3EB0ABC",
  phone: "5511999990000",
  fromMe: false,
  momment: 1632228638000,
  status: "RECEIVED",
  chatName: "Paciente",
  senderName: "Paciente Teste",
  broadcast: false,
  type: "ReceivedCallback",
};

Deno.test("token do webhook: precisa do segredo e de token igual", () => {
  assert(tokenWebhookZapiValido("abc", "abc"));
  assert(!tokenWebhookZapiValido("abc", ""));
  assert(!tokenWebhookZapiValido("", "abc"));
  assert(!tokenWebhookZapiValido("abd", "abc"));
});

Deno.test("texto recebido vira messages[] da Meta com contato", () => {
  const { envelope, tipo } = envelopeZapi({ ...base, text: { message: "Oi" } });
  assertEquals(tipo, "mensagem");
  assertEquals(envelope._ic_provedor, "zapi");
  assertEquals(envelope.zapi_instance_id, "INST1");
  const ch = envelope.entry[0].changes[0];
  assertEquals(ch.field, "messages");
  assertEquals(ch.value.metadata.display_phone_number, "5511916863913");
  assertEquals(ch.value.messages[0], { id: "3EB0ABC", timestamp: "1632228638", from: "5511999990000", type: "text", text: { body: "Oi" } });
  assertEquals(ch.value.contacts[0], { wa_id: "5511999990000", profile: { name: "Paciente Teste" } });
});

Deno.test("enviada pelo celular (fromMe) vira eco com o lead em 'to'", () => {
  const { envelope, tipo } = envelopeZapi({ ...base, fromMe: true, fromApi: false, text: { message: "Bom dia" } });
  assertEquals(tipo, "eco");
  const ch = envelope.entry[0].changes[0];
  assertEquals(ch.field, "smb_message_echoes");
  const m = ch.value.message_echoes[0];
  assertEquals(m.from, "5511916863913");
  assertEquals(m.to, "5511999990000");
  assertEquals(ch.value.contacts, undefined);
});

Deno.test("enviada pela API (CRM ou IA) e ignorada para a IA nao achar que humano assumiu", () => {
  assertEquals(motivoIgnorarZapi({ ...base, fromMe: true, fromApi: true, text: { message: "x" } }), "enviada pela api");
  const { envelope } = envelopeZapi({ ...base, fromMe: true, fromApi: true, text: { message: "x" } });
  assertEquals(envelope.entry, []);
});

Deno.test("grupo, canal, lista, status e outros callbacks sao ignorados", () => {
  assertEquals(motivoIgnorarZapi({ ...base, isGroup: true }), "grupo");
  assertEquals(motivoIgnorarZapi({ ...base, phone: "1203630@g.us" }), "grupo");
  assertEquals(motivoIgnorarZapi({ ...base, isNewsletter: true }), "canal");
  assertEquals(motivoIgnorarZapi({ ...base, broadcast: true }), "lista de transmissao");
  assertEquals(motivoIgnorarZapi({ ...base, isStatusReply: true }), "resposta a status");
  assertEquals(motivoIgnorarZapi({ ...base, waitingMessage: true }), "aguardando mensagem");
  assertEquals(motivoIgnorarZapi({ type: "MessageStatusCallback" }), "evento MessageStatusCallback");
  assertEquals(motivoIgnorarZapi(null), "payload invalido");
  assertEquals(motivoIgnorarZapi({ ...base, text: { message: "ok" } }), null);
});

Deno.test("modelo (template) de empresa e ignorado: nao vira card nem aciona a IA", () => {
  const modelo = {
    ...base,
    hydratedTemplate: { header: {}, message: "Pode nos contar? E uma pesquisa de 3 minutos.", footer: "", title: "", templateId: "1", hydratedButtons: [] },
  };
  assertEquals(motivoIgnorarZapi(modelo), "modelo de empresa");
  const { envelope } = envelopeZapi(modelo);
  assertEquals(envelope.entry, []);
  assertEquals(envelope._ic_ignorado, "modelo de empresa");
  // Mensagem comum continua passando.
  assertEquals(motivoIgnorarZapi({ ...base, text: { message: "Oi, quero agendar" } }), null);
});

Deno.test("audio leva o link e o tipo para a transcricao", () => {
  const m = mensagemZapiParaMeta({
    ...base,
    audio: { ptt: true, seconds: 10, audioUrl: "https://x.example/a.ogg", mimeType: "audio/ogg; codecs=opus" },
  });
  assertEquals(m.type, "audio");
  assertEquals(m.audio, { id: "", url: "https://x.example/a.ogg", mime_type: "audio/ogg; codecs=opus" });
});

Deno.test("imagem, documento, reacao e lista no vocabulario da Meta", () => {
  const img = mensagemZapiParaMeta({ ...base, image: { imageUrl: "https://i", mimeType: "image/jpeg", caption: "exame" } });
  assertEquals(img.type, "image");
  assertEquals(img.image.caption, "exame");
  const doc = mensagemZapiParaMeta({ ...base, document: { documentUrl: "https://d", fileName: "guia.pdf" } });
  assertEquals(doc.type, "document");
  assertEquals(doc.document.filename, "guia.pdf");
  const reac = mensagemZapiParaMeta({ ...base, reaction: { value: "👍" } });
  assertEquals(reac.reaction, { emoji: "👍" });
  const lista = mensagemZapiParaMeta({ ...base, listResponseMessage: { message: "Manhã", selectedRowId: "1" } });
  assertEquals(lista.interactive.list_reply, { id: "1", title: "Manhã" });
  const outro = mensagemZapiParaMeta({ ...base, poll: {} });
  assertEquals(outro.type, "unknown");
});

Deno.test("sem messageId ou telefone nao vira mensagem; @lid passa como veio", () => {
  assertEquals(mensagemZapiParaMeta({ ...base, messageId: "", text: { message: "x" } }), null);
  assertEquals(mensagemZapiParaMeta({ ...base, phone: "", text: { message: "x" } }), null);
  const lid = mensagemZapiParaMeta({ ...base, phone: "81896604192873@lid", text: { message: "x" } });
  assertEquals(lid.from, "81896604192873@lid");
});

Deno.test("envio: URL com instancia e token, corpo so com digitos", () => {
  assertEquals(
    urlEnvioTextoZapi({ instancia: "INST1", token: "TK", clientToken: "CT" }),
    "https://api.z-api.io/instances/INST1/token/TK/send-text",
  );
  assertEquals(corpoTextoZapi("+55 (11) 99999-0000", "Olá"), { phone: "5511999990000", message: "Olá" });
});

Deno.test("resposta da Z-API: sucesso so com 2xx e messageId", () => {
  const ok = interpretarRespostaZapi(200, { zaapId: "Z1", messageId: "M1", id: "M1" });
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.wamid, "M1");
  const semId = interpretarRespostaZapi(200, {});
  assert(!semId.ok);
  const erro = interpretarRespostaZapi(400, { error: "null not allowed" });
  assert(!erro.ok);
  if (!erro.ok) assertEquals(erro.mensagemMeta, "null not allowed");
});

Deno.test("midia: so https", () => {
  assert(urlMidiaZapiPermitida("https://storage.example/a.ogg"));
  assert(!urlMidiaZapiPermitida("http://storage.example/a.ogg"));
  assert(!urlMidiaZapiPermitida("nada"));
});

Deno.test("delayTyping vai no corpo so quando pedido e cresce com o texto", () => {
  assertEquals(corpoTextoZapi("5511999990000", "Oi", 3), { phone: "5511999990000", message: "Oi", delayTyping: 3 });
  assertEquals(corpoTextoZapi("5511999990000", "Oi", 0), { phone: "5511999990000", message: "Oi" });
  assertEquals(segundosDigitando("Oi"), 2);
  assertEquals(segundosDigitando("x".repeat(140)), 7);
  assertEquals(segundosDigitando("x".repeat(2000)), 9);
});
