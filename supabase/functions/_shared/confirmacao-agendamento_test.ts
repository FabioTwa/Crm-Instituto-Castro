import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { horasConfirmacao, inicioDaJanela, MAX_TENTATIVAS, precisaLembrete, textoConfirmacao } from "./confirmacao-agendamento.ts";
import { respostaProibida } from "./pos-validacao.ts";

// Horarios em UTC; Sao Paulo = UTC-3.
const QUA_15H = "2026-10-28T18:00:00Z"; // quarta 28/10 15:00 local
const SEG_10H = "2026-10-26T13:00:00Z"; // segunda 26/10 10:00 local

Deno.test("horasConfirmacao: vazio, 0 ou sem a chave = desligado", () => {
  assertEquals(horasConfirmacao({}), 0);
  assertEquals(horasConfirmacao({ confirmacao_antes_horas: "" }), 0);
  assertEquals(horasConfirmacao({ confirmacao_antes_horas: "0" }), 0);
  assertEquals(horasConfirmacao({ confirmacao_antes_horas: "abc" }), 0);
  assertEquals(horasConfirmacao({ confirmacao_antes_horas: "24" }), 24);
  assertEquals(horasConfirmacao({ confirmacao_antes_horas: "500" }), 72);
});

Deno.test("janela que cai no domingo adianta para sabado", () => {
  const ini = Date.parse(SEG_10H);
  assertEquals(new Date(inicioDaJanela(ini, 24)).toISOString(), "2026-10-24T13:00:00.000Z");
  const qua = Date.parse(QUA_15H);
  assertEquals(new Date(inicioDaJanela(qua, 24)).toISOString(), "2026-10-27T18:00:00.000Z");
});

Deno.test("precisaLembrete: so dentro da janela, com antecedencia e sem repetir", () => {
  const base = { inicio: QUA_15H, criadoEm: "2026-10-22T12:00:00Z", status: "pendente", horas: 24, tentativas: 0 };
  // antes da janela (25 h antes)
  assertEquals(precisaLembrete({ ...base, agora: new Date("2026-10-27T17:00:00Z") }), false);
  // na janela (24 h antes) e um pouco depois
  assertEquals(precisaLembrete({ ...base, agora: new Date("2026-10-27T18:00:00Z") }), true);
  assertEquals(precisaLembrete({ ...base, agora: new Date("2026-10-28T10:00:00Z") }), true);
  // perto demais do horario
  assertEquals(precisaLembrete({ ...base, agora: new Date("2026-10-28T16:30:00Z") }), false);
  // desligado, cancelado, ja tentou demais
  assertEquals(precisaLembrete({ ...base, horas: 0, agora: new Date("2026-10-27T18:00:00Z") }), false);
  assertEquals(precisaLembrete({ ...base, status: "cancelado", agora: new Date("2026-10-27T18:00:00Z") }), false);
  assertEquals(precisaLembrete({ ...base, tentativas: MAX_TENTATIVAS, agora: new Date("2026-10-27T18:00:00Z") }), false);
  // marcado ja dentro da janela (ontem para hoje): nao lembra
  assertEquals(precisaLembrete({ ...base, criadoEm: "2026-10-27T20:00:00Z", agora: new Date("2026-10-27T21:00:00Z") }), false);
  assertEquals(precisaLembrete({ ...base, status: "confirmado", agora: new Date("2026-10-27T18:00:00Z") }), true);
});

Deno.test("textoConfirmacao: amanha/hoje/data, endereco, pergunta e pos-validacao", () => {
  const amanha = textoConfirmacao({ primeiroNome: "Maria Silva", inicioIso: QUA_15H, agora: new Date("2026-10-27T18:00:00Z"), variante: 0 });
  assertStringIncludes(amanha, "Oi, Maria!");
  assertStringIncludes(amanha, "amanhã, 28/10 (quarta-feira), às 15:00");
  assertStringIncludes(amanha, "Paes de Barros");
  const hoje = textoConfirmacao({ primeiroNome: null, inicioIso: QUA_15H, agora: new Date("2026-10-28T11:00:00Z"), variante: 1 });
  assertStringIncludes(hoje, "Oi! Tudo bem?");
  assertStringIncludes(hoje, "hoje, 28/10 (quarta-feira), às 15:00");
  const sabado = textoConfirmacao({ primeiroNome: "Ana", inicioIso: SEG_10H, agora: new Date("2026-10-24T13:00:00Z"), variante: 2 });
  assertStringIncludes(sabado, "no dia 26/10 (segunda-feira), às 10:00");
  for (let v = 0; v < 3; v++) {
    const t = textoConfirmacao({ primeiroNome: "Ana", inicioIso: QUA_15H, agora: new Date("2026-10-27T18:00:00Z"), variante: v });
    assertEquals(respostaProibida(t), null);
    assert(t.trim().endsWith("?"));
    assertEquals(/robô|automátic|assistente virtual/i.test(t), false);
  }
});
