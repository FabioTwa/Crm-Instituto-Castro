import { assert, assertEquals } from "jsr:@std/assert";
import { decidirGrupo, ehEventoGrupoZapi, extrairMensagemGrupo, normalizarNomeGrupo } from "./grupo-leitura.ts";
import { envelopeZapi } from "./zapi.ts";

const base = {
  type: "ReceivedCallback",
  instanceId: "INST",
  messageId: "3EB0ABC",
  phone: "120363012345678901-group",
  connectedPhone: "5511911844992",
  isGroup: true,
  chatName: "Treinamento Jully",
  participantPhone: "5511999998888",
  senderName: "Maria",
  fromMe: false,
  momment: 1795013772000,
};

Deno.test("grupo: detecta por isGroup e pelo id do chat", () => {
  assert(ehEventoGrupoZapi(base));
  assert(ehEventoGrupoZapi({ ...base, isGroup: undefined }));
  assert(ehEventoGrupoZapi({ ...base, isGroup: undefined, phone: "123@g.us" }));
  assert(!ehEventoGrupoZapi({ ...base, isGroup: false, phone: "5511999998888" }));
  assert(!ehEventoGrupoZapi({ ...base, type: "MessageStatusCallback" }));
});

Deno.test("grupo: texto com autor", () => {
  const m = extrairMensagemGrupo({ ...base, text: { message: "Bom dia, equipe" } })!;
  assertEquals(m.grupoId, "120363012345678901-group");
  assertEquals(m.tipo, "texto");
  assertEquals(m.texto, "Bom dia, equipe");
  assertEquals(m.autorTelefone, "5511999998888");
  assertEquals(m.autorNome, "Maria");
  assertEquals(m.deMim, false);
  assertEquals(m.enviadaEm, new Date(1795013772000).toISOString());
});

Deno.test("grupo: audio guarda o link https, sem texto", () => {
  const m = extrairMensagemGrupo({ ...base, audio: { audioUrl: "https://x.example/a.ogg", mimeType: "audio/ogg; codecs=opus" } })!;
  assertEquals(m.tipo, "audio");
  assertEquals(m.midiaUrl, "https://x.example/a.ogg");
  assertEquals(m.texto, null);
  const http = extrairMensagemGrupo({ ...base, audio: { audioUrl: "http://x.example/a.ogg" } })!;
  assertEquals(http.midiaUrl, null);
});

Deno.test("grupo: autor por lid quando nao ha telefone", () => {
  const m = extrairMensagemGrupo({ ...base, participantPhone: "", participantLid: "999@lid", text: { message: "oi" } })!;
  assertEquals(m.autorTelefone, "999@lid");
});

Deno.test("grupo: sem messageId nao grava", () => {
  assertEquals(extrairMensagemGrupo({ ...base, messageId: "" }), null);
});

Deno.test("grupo: decide por id, vincula por nome exato uma vez", () => {
  const livre = [{ id: 1, nome: "Treinamento Jully", grupo_id: null }];
  assertEquals(decidirGrupo(livre, "G1", "treinamento  jully")?.acao, "vincular");
  assertEquals(decidirGrupo(livre, "G1", "Treinamento Jully 2"), null);
  assertEquals(decidirGrupo(livre, "G1", ""), null);
  const vinculado = [{ id: 1, nome: "Treinamento Jully", grupo_id: "G1" }];
  assertEquals(decidirGrupo(vinculado, "G1", "outro nome")?.acao, "id");
  // outro grupo renomeado para o mesmo nome nao entra
  assertEquals(decidirGrupo(vinculado, "G2", "Treinamento Jully"), null);
});

Deno.test("grupo: normaliza acento e caixa", () => {
  assertEquals(normalizarNomeGrupo("  Treinamento   JÚLLY "), "treinamento jully");
});

Deno.test("grupo: caminho do lead continua ignorando grupo (nao vira card)", () => {
  const { envelope } = envelopeZapi({ ...base, text: { message: "oi" } });
  assertEquals(envelope._ic_ignorado, "grupo");
});
