import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  configRetomadaQueda,
  eventoParaReprocessar,
  mensagensDaQueda,
  instrucaoRetomadaQueda,
  jaNoCrm,
  podeRetomarAgora,
  retomadaVencida,
  selecionarChatsDaQueda,
  TEXTOS_RETOMADA_QUEDA,
  TEXTOS_RETOMADA_QUEDA_NOVO,
  textoRetomadaQuedaFixo,
} from "./retomada-queda.ts";
import { envelopeZapi, interpretarChatsZapi, interpretarMensagensChatZapi, urlMensagensChatZapi } from "./zapi.ts";
import { respostaProibida } from "./pos-validacao.ts";

const T0 = Date.parse("2026-10-28T15:00:00.000Z");
const min = (m: number) => T0 + m * 60000;
const chat = (telefone: string, ultimaEm: number | null, extra: Record<string, unknown> = {}) => ({
  telefone, nome: "", grupo: false, naoLidas: 1, ultimaEm, ...extra,
});

Deno.test("configRetomadaQueda: padroes e limites", () => {
  assertEquals(configRetomadaQueda({}), { ligada: true, intervaloMin: 3, horario: "08:00-20:00", desconhecidos: true });
  const c = configRetomadaQueda({ retomada_queda_ligada: "false", retomada_queda_intervalo_min: "500", retomada_queda_desconhecidos: "FALSE" });
  assertEquals([c.ligada, c.intervaloMin, c.desconhecidos], [false, 60, false]);
  assertEquals(configRetomadaQueda({ retomada_queda_intervalo_min: "0" }).intervaloMin, 1);
  assertEquals(configRetomadaQueda({ retomada_queda_intervalo_min: "abc" }).intervaloMin, 3);
});

Deno.test("selecionarChatsDaQueda: janela, grupos, ignorados, duplicados e ordem", () => {
  const r = selecionarChatsDaQueda([
    chat("5511988887777", min(5)),
    chat("11977776666", min(2)), // sem 55: vira canonico
    chat("5511966665555", min(-10)), // antes da queda
    chat("5511955554444", min(30)), // depois do fim
    chat("120363000000000000-group", min(3), { grupo: true }),
    chat("5511944443333", min(4)), // numero da equipe
    chat("5511988887777", min(7)), // duplicado: fica o mais novo
    chat("123", min(4)), // nao e telefone BR
    chat("5511933332222", null),
  ], { desconectadoEm: min(0), ate: min(20), ignorar: ["11 94444-3333"] });
  assertEquals(r.map((c) => [c.telefone, c.ultimaEm]), [["5511977776666", min(2)], ["5511988887777", min(7)]]);
});

Deno.test("jaNoCrm: casa o horario da Z-API com o do CRM com margem", () => {
  assertEquals(jaNoCrm(null, min(5)), false);
  assertEquals(jaNoCrm(min(5), min(5)), true);
  assertEquals(jaNoCrm(min(4), min(5)), true); // 60 s de diferenca
  assertEquals(jaNoCrm(min(3), min(5)), false); // 2 min antes: a mensagem da queda nao chegou
});

Deno.test("podeRetomarAgora e retomadaVencida", () => {
  assertEquals(podeRetomarAgora(null, T0, 3), true);
  assertEquals(podeRetomarAgora(min(-2), T0, 3), false);
  assertEquals(podeRetomarAgora(min(-3), T0, 3), true);
  assertEquals(retomadaVencida(min(-60), T0), false);
  assertEquals(retomadaVencida(T0 - 49 * 3600 * 1000, T0), true);
});

Deno.test("textos fixos: sem emoji e passam na pos-validacao", () => {
  for (const t of [...TEXTOS_RETOMADA_QUEDA, ...TEXTOS_RETOMADA_QUEDA_NOVO]) {
    assertEquals(respostaProibida(t), null, t);
    assert(!/\p{Extended_Pictographic}/u.test(t), t);
  }
  assertEquals(textoRetomadaQuedaFixo(true, () => 0), TEXTOS_RETOMADA_QUEDA[0]);
  assertEquals(textoRetomadaQuedaFixo(false, () => 0.99), TEXTOS_RETOMADA_QUEDA_NOVO[1]);
});

Deno.test("instrucaoRetomadaQueda: deixa claro que o texto nao chegou", () => {
  const t = instrucaoRetomadaQueda(15);
  assert(t.includes("NÃO chegou"));
  assert(t.includes("cerca de 15 minutos"));
  assert(instrucaoRetomadaQueda(180).includes("cerca de 3 horas"));
});

Deno.test("interpretarChatsZapi: campos, grupos e erros", () => {
  const r = interpretarChatsZapi(200, [
    { phone: "5511988887777", name: "Maria", isGroup: false, unread: "2", lastMessageTime: "1761663600" },
    { phone: "120363000000000000-group", name: "Grupo", isGroup: true, lastMessageTime: 1761663600000 },
    { phone: "5511977776666", lastMessageTime: null },
    null,
  ]);
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.chats.length, 3);
  assertEquals(r.chats[0], { telefone: "5511988887777", nome: "Maria", grupo: false, naoLidas: 2, ultimaEm: 1761663600000 });
  assertEquals(r.chats[1].grupo, true);
  assertEquals(r.chats[1].ultimaEm, 1761663600000);
  assertEquals(r.chats[2].ultimaEm, null);
  assertEquals(interpretarChatsZapi(401, { error: "unauthorized" }), { ok: false, detalhe: "unauthorized" });
  assertEquals(interpretarChatsZapi(200, { value: [] }).ok, false);
});

Deno.test("mensagensDaQueda: so recebidas, na janela, sem repetir, em ordem", () => {
  const m = (id: string, t: number, extra: Record<string, unknown> = {}) => ({ messageId: id, momment: t, phone: "5511988887777", text: { message: id }, ...extra });
  const r = mensagensDaQueda([
    m("C", min(6)),
    m("A", min(2)),
    m("B", min(4), { fromMe: true }), // a casa falou
    m("A", min(2)), // repetida
    m("D", min(-5)), // antes da queda
    m("E", min(40)), // depois do fim
    m("", min(3)), // sem id
  ], { desdeMs: min(0), ateMs: min(30) });
  assertEquals(r.map((x) => x.messageId), ["A", "C"]);
  const muitas = Array.from({ length: 15 }, (_, i) => m(`M${i}`, min(i + 1)));
  assertEquals(mensagensDaQueda(muitas, { desdeMs: min(0), ateMs: min(30), limite: 3 }).map((x) => x.messageId), ["M12", "M13", "M14"]);
});

Deno.test("eventoParaReprocessar: o webhook aceita como mensagem recebida", () => {
  const ev = eventoParaReprocessar(
    { messageId: "ABC", momment: min(2), phone: "5511988887777", fromMe: false, senderName: "Maria", text: { message: "quero marcar" } },
    { instancia: "INST", numero: "5511920622607", telefoneLead: "5511988887777" },
  );
  const { envelope, tipo } = envelopeZapi(ev);
  assertEquals(tipo, "mensagem");
  const v = envelope.entry[0].changes[0].value;
  assertEquals(v.messages[0].id, "ABC");
  assertEquals(v.messages[0].from, "5511988887777");
  assertEquals(v.messages[0].text.body, "quero marcar");
  assertEquals(v.metadata.zapi_instance_id, "INST");
  assertEquals(v.contacts[0].profile.name, "Maria");
});

Deno.test("mensagens da conversa na Z-API: URL e resposta", () => {
  const canal = { instancia: "INST", token: "TOK", clientToken: "CT" };
  assertEquals(urlMensagensChatZapi(canal, "+55 (11) 98888-7777", 20, false), "https://api.z-api.io/instances/INST/token/TOK/chat-messages/5511988887777?amount=20");
  assertEquals(urlMensagensChatZapi(canal, "5511988887777", 20, true), "https://api.z-api.io/instances/INST/token/TOK/chat-messages/5511988887777?amount=20&lastMessageId=");
  const r = interpretarMensagensChatZapi(200, [{ messageId: "A" }, null, "x"]);
  assert(r.ok);
  if (r.ok) assertEquals(r.mensagens.length, 1);
  assertEquals(interpretarMensagensChatZapi(404, { error: "not found" }), { ok: false, detalhe: "not found" });
});
