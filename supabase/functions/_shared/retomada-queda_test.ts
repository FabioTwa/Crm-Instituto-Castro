import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  configRetomadaQueda,
  instrucaoRetomadaQueda,
  jaNoCrm,
  podeRetomarAgora,
  retomadaVencida,
  selecionarChatsDaQueda,
  TEXTOS_RETOMADA_QUEDA,
  TEXTOS_RETOMADA_QUEDA_NOVO,
  textoRetomadaQuedaFixo,
} from "./retomada-queda.ts";
import { interpretarChatsZapi } from "./zapi.ts";
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
