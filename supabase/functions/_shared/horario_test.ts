import { assertEquals, assert } from "jsr:@std/assert";
import { dataLocal, dentroDoHorario, interpretarDia, partesNoFuso, proximoSlot } from "./horario.ts";

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
