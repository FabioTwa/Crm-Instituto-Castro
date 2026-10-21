import { assertEquals, assert } from "jsr:@std/assert";
import { dataLocal, dentroDoHorario, interpretarDia, interpretarHorario, partesNoFuso, proximoSlot, proximosSlotsLivres, slotOcupado } from "./horario.ts";

const TZ = "America/Sao_Paulo";

// Sao Paulo = UTC-3 (sem horario de verao desde 2019).
Deno.test("dataLocal converte Sao Paulo -> UTC", () => {
  const d = dataLocal(2026, 10, 5, 9, 0, TZ); // segunda 05/10/2026 09:00 SP
  assertEquals(d.toISOString(), "2026-10-05T12:00:00.000Z");
  const p = partesNoFuso(d, TZ);
  assertEquals([p.hora, p.minuto, p.diaSemana], [9, 0, 1]);
});

Deno.test("dentro do horario em dia de semana", () => {
  const dez = dataLocal(2026, 10, 6, 10, 0, TZ); // terca 10:00
  assert(dentroDoHorario(dez, "08:00", "19:00", TZ));
});

Deno.test("fora do horario: antes de abrir e depois de fechar", () => {
  assert(!dentroDoHorario(dataLocal(2026, 10, 6, 7, 59, TZ), "08:00", "19:00", TZ));
  assert(!dentroDoHorario(dataLocal(2026, 10, 6, 19, 0, TZ), "08:00", "19:00", TZ));
});

Deno.test("sexta fecha as 18h mesmo com fim configurado 19h; fim de semana sempre fora", () => {
  assert(dentroDoHorario(dataLocal(2026, 10, 9, 17, 30, TZ), "08:00", "19:00", TZ)); // sexta 17:30
  assert(!dentroDoHorario(dataLocal(2026, 10, 9, 18, 10, TZ), "08:00", "19:00", TZ)); // sexta 18:10
  assert(!dentroDoHorario(dataLocal(2026, 10, 10, 10, 0, TZ), "08:00", "19:00", TZ)); // sabado
  assert(!dentroDoHorario(dataLocal(2026, 10, 11, 10, 0, TZ), "08:00", "19:00", TZ)); // domingo
});

Deno.test("horario mal formado nunca e 'dentro'", () => {
  assert(!dentroDoHorario(dataLocal(2026, 10, 6, 10, 0, TZ), "oito", "19:00", TZ));
});

Deno.test("proximoSlot: dia util pedido, manha e tarde", () => {
  const agora = dataLocal(2026, 10, 5, 8, 0, TZ); // segunda 08:00
  const m = proximoSlot("2026-10-06", "manha", agora, TZ);
  assertEquals(m.inicio.toISOString(), "2026-10-06T12:00:00.000Z"); // terca 09:00 SP
  assertEquals(m.fim.toISOString(), "2026-10-06T12:30:00.000Z");
  const t = proximoSlot("2026-10-06", "tarde", agora, TZ);
  assertEquals(t.inicio.toISOString(), "2026-10-06T17:00:00.000Z"); // terca 14:00 SP
});

Deno.test("proximoSlot: fim de semana e sexta a noite caem na segunda", () => {
  const sextaNoite = dataLocal(2026, 10, 9, 18, 30, TZ);
  const s = proximoSlot("hoje", "tarde", sextaNoite, TZ);
  assertEquals(s.inicio.toISOString(), "2026-10-12T17:00:00.000Z"); // segunda 14:00 SP
  const sab = proximoSlot("2026-10-10", "manha", sextaNoite, TZ); // sabado pedido
  assertEquals(sab.inicio.toISOString(), "2026-10-12T12:00:00.000Z");
});

Deno.test("proximoSlot: 'hoje a tarde' as 17h vai para amanha", () => {
  const agora = dataLocal(2026, 10, 6, 17, 0, TZ); // terca 17:00
  const s = proximoSlot("hoje", "tarde", agora, TZ);
  assertEquals(s.inicio.toISOString(), "2026-10-07T17:00:00.000Z"); // quarta 14:00
});

Deno.test("interpretarDia: amanha, dia da semana com acento, DD/MM", () => {
  const agora = dataLocal(2026, 10, 5, 8, 0, TZ); // segunda
  assertEquals(interpretarDia("amanhã", agora, TZ), { ano: 2026, mes: 10, dia: 6 });
  assertEquals(interpretarDia("Quinta-feira", agora, TZ), { ano: 2026, mes: 10, dia: 8 });
  assertEquals(interpretarDia("próxima terça", agora, TZ), { ano: 2026, mes: 10, dia: 6 });
  assertEquals(interpretarDia("15/10", agora, TZ), { ano: 2026, mes: 10, dia: 15 });
  assertEquals(interpretarDia("qualquer coisa", agora, TZ), { ano: 2026, mes: 10, dia: 5 });
});

Deno.test("proximoSlot: horario pedido pelo lead e respeitado", () => {
  const agora = dataLocal(2026, 10, 15, 12, 0, TZ); // quinta 12:00
  const s = proximoSlot("2026-10-26", "tarde", agora, TZ, "15:00");
  assertEquals(s.inicio.toISOString(), "2026-10-26T18:00:00.000Z"); // segunda 15:00 SP
  assertEquals(s.fim.toISOString(), "2026-10-26T18:30:00.000Z");
  const meia = proximoSlot("2026-10-26", "manha", agora, TZ, "10h30");
  assertEquals(meia.inicio.toISOString(), "2026-10-26T13:30:00.000Z"); // 10:30 SP
  const quebrado = proximoSlot("2026-10-26", "tarde", agora, TZ, "15:10");
  assertEquals(quebrado.inicio.toISOString(), "2026-10-26T18:00:00.000Z"); // arredonda para 15:00
});

Deno.test("proximoSlot: horario fora do expediente ou invalido usa o padrao do periodo", () => {
  const agora = dataLocal(2026, 10, 15, 12, 0, TZ);
  assertEquals(proximoSlot("2026-10-26", "tarde", agora, TZ, "20:00").inicio.toISOString(), "2026-10-26T17:00:00.000Z");
  assertEquals(proximoSlot("2026-10-26", "manha", agora, TZ, "07:00").inicio.toISOString(), "2026-10-26T12:00:00.000Z");
  assertEquals(proximoSlot("2026-10-26", "tarde", agora, TZ, "depois do almoço").inicio.toISOString(), "2026-10-26T17:00:00.000Z");
  // Sexta: ultimo inicio 17:30.
  assertEquals(proximoSlot("2026-10-23", "tarde", agora, TZ, "18:00").inicio.toISOString(), "2026-10-23T17:00:00.000Z");
  assertEquals(proximoSlot("2026-10-23", "tarde", agora, TZ, "17:30").inicio.toISOString(), "2026-10-23T20:30:00.000Z");
});

Deno.test("proximoSlot: horario de hoje que ja passou vai para o proximo dia util no mesmo horario", () => {
  const agora = dataLocal(2026, 10, 15, 16, 0, TZ); // quinta 16:00
  const s = proximoSlot("hoje", "tarde", agora, TZ, "15:00");
  assertEquals(s.inicio.toISOString(), "2026-10-16T18:00:00.000Z"); // sexta 15:00
});

Deno.test("interpretarHorario: formatos comuns", () => {
  assertEquals(interpretarHorario("15:00"), 900);
  assertEquals(interpretarHorario("15h"), 900);
  assertEquals(interpretarHorario("15h30"), 930);
  assertEquals(interpretarHorario("15hrs"), 900);
  assertEquals(interpretarHorario(" 9 "), 540);
  assertEquals(interpretarHorario(""), null);
  assertEquals(interpretarHorario("25:00"), null);
  assertEquals(interpretarHorario("tarde"), null);
});

Deno.test("slotOcupado e proximosSlotsLivres pulam horarios tomados", () => {
  // quinta 22/10/2026 10:00 em Sao Paulo = 13:00Z
  const agora = new Date("2026-10-22T11:00:00.000Z"); // 08:00 local
  const ocupados = [{ inicio: "2026-10-22T13:00:00.000Z", fim: "2026-10-22T13:30:00.000Z" }];
  const pedido = new Date("2026-10-22T13:00:00.000Z");
  assertEquals(slotOcupado(pedido, new Date(pedido.getTime() + 30 * 60000), ocupados), true);
  assertEquals(slotOcupado(new Date("2026-10-22T13:30:00.000Z"), new Date("2026-10-22T14:00:00.000Z"), ocupados), false);
  const livres = proximosSlotsLivres(pedido, ocupados, 2, agora).map((d) => d.toISOString());
  assertEquals(livres, ["2026-10-22T13:30:00.000Z", "2026-10-22T14:00:00.000Z"]);
});

Deno.test("proximosSlotsLivres: depois do ultimo horario da sexta vai para segunda", () => {
  const agora = new Date("2026-10-23T20:00:00.000Z"); // sexta 17:00 local
  const livres = proximosSlotsLivres(agora, [], 1, agora).map((d) => d.toISOString());
  assertEquals(livres, ["2026-10-26T11:00:00.000Z"]); // segunda 08:00
});
