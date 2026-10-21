import { assertEquals } from "jsr:@std/assert@1";
import { decidirFollowup, followupsDoConfig, podeMandarFollowup, textoFollowupFixo, TEXTOS_FOLLOWUP } from "./ia-followup.ts";
import { respostaProibida } from "./pos-validacao.ts";

const agora = new Date("2026-10-22T15:00:00.000Z"); // quinta 12:00 em Sao Paulo
const antes = (min: number) => new Date(agora.getTime() - min * 60000).toISOString();
const ia = (min: number, extra: Record<string, unknown> = {}) => ({ autor: "ia", criada_em: antes(min), payload_raw: { ia: true, ...extra } });
const lead = (min: number) => ({ autor: "lead", criada_em: antes(min), payload_raw: null });

Deno.test("followupsDoConfig: desligado por padrao, lista e limites", () => {
  assertEquals(followupsDoConfig({}), []);
  assertEquals(followupsDoConfig({ followups_minutos: "120,1440,4320" }), [120, 1440, 4320]);
  assertEquals(followupsDoConfig({ followups_minutos: "1440, 60" }), [60, 1440]);
  assertEquals(followupsDoConfig({ followups_minutos: "5,99999" }), [30, 20160]);
  assertEquals(followupsDoConfig({ followups_minutos: "" }), []);
  assertEquals(followupsDoConfig({ followups_minutos: "0" }), []);
});

Deno.test("primeira retomada depois de 2 h parada", () => {
  assertEquals(decidirFollowup({ recentes: [ia(119), lead(130)], agora, minutos: [120, 1440] }), null);
  assertEquals(decidirFollowup({ recentes: [ia(121), lead(130)], agora, minutos: [120, 1440] }), { numero: 1, parado_min: 121 });
});

Deno.test("segunda retomada conta desde a mensagem que parou a conversa", () => {
  const recentes = [ia(60, { followup: true }), ia(1500), lead(1510)];
  assertEquals(decidirFollowup({ recentes, agora, minutos: [120, 1440] }), { numero: 2, parado_min: 1500 });
  assertEquals(decidirFollowup({ recentes: [ia(60, { followup: true }), ia(1000)], agora, minutos: [120, 1440] }), null);
});

Deno.test("depois da ultima retomada fica quieta", () => {
  const recentes = [ia(10, { followup: true }), ia(100, { followup: true }), ia(9000)];
  assertEquals(decidirFollowup({ recentes, agora, minutos: [120, 1440] }), null);
});

Deno.test("lead ou vendedor por ultimo: nao retoma", () => {
  assertEquals(decidirFollowup({ recentes: [lead(500)], agora, minutos: [120] }), null);
  assertEquals(decidirFollowup({ recentes: [{ autor: "vendedor", criada_em: antes(500), payload_raw: null }], agora, minutos: [120] }), null);
  assertEquals(decidirFollowup({ recentes: [], agora, minutos: [120] }), null);
});

Deno.test("conversa encerrada pela equipe nao recebe retomada", () => {
  assertEquals(decidirFollowup({ recentes: [ia(500, { encerramento: true })], agora, minutos: [120] }), null);
});

Deno.test("janela de envio: 8h as 20h, nunca domingo", () => {
  assertEquals(podeMandarFollowup(agora, "08:00-20:00"), true);
  assertEquals(podeMandarFollowup(new Date("2026-10-22T23:30:00.000Z"), "08:00-20:00"), false); // 20:30
  assertEquals(podeMandarFollowup(new Date("2026-10-22T10:30:00.000Z"), null), false); // 07:30
  assertEquals(podeMandarFollowup(new Date("2026-10-25T15:00:00.000Z"), null), false); // domingo
  assertEquals(podeMandarFollowup(new Date("2026-10-24T15:00:00.000Z"), null), true); // sabado
});

Deno.test("textos fixos de retomada passam na pos-validacao", () => {
  for (const grupo of TEXTOS_FOLLOWUP) for (const t of grupo) assertEquals(respostaProibida(t), null, t);
  assertEquals(textoFollowupFixo(9, () => 0), TEXTOS_FOLLOWUP[2][0]);
});
