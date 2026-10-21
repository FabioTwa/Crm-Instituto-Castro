import { assertEquals } from "jsr:@std/assert@1";
import { decidirRajada, rajadaDoConfig } from "./rajada.ts";

const t0 = Date.parse("2026-10-16T17:00:00.000Z");
const msg = (id: string, ms: number) => ({ id, criada_em: new Date(t0 + ms).toISOString() });

Deno.test("mensagem mais nova do lead: a invocacao antiga desiste", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("b", 500), agoraMs: t0 + 1000, inicioEsperaMs: t0 }), { acao: "absorvida" });
});

Deno.test("pessoa ainda digitando: espera completar 30 s de silencio", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 0), agoraMs: t0 + 1000, inicioEsperaMs: t0 + 1000 }), { acao: "esperar", ms: 29000 });
});

Deno.test("30 s sem mensagem nova: responde", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 0), agoraMs: t0 + 30000, inicioEsperaMs: t0 }), { acao: "responder" });
});

Deno.test("teto: nunca segura mais que 60 s desde o inicio da espera", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 59500), agoraMs: t0 + 60500, inicioEsperaMs: t0 }), { acao: "responder" });
});

Deno.test("silencio e teto vindos da config", () => {
  assertEquals(
    decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 0), agoraMs: t0 + 1000, inicioEsperaMs: t0, silencioMs: 3000, tetoMs: 12000 }),
    { acao: "esperar", ms: 2000 },
  );
});

Deno.test("sem leitura da ultima mensagem: responde (nao trava a IA)", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: null, agoraMs: t0, inicioEsperaMs: t0 }), { acao: "responder" });
});

Deno.test("rajadaDoConfig: padrao 30/60, limites e teto nunca abaixo do silencio", () => {
  assertEquals(rajadaDoConfig({}), { silencioMs: 30000, tetoMs: 60000 });
  assertEquals(rajadaDoConfig({ rajada_silencio_segundos: "5", rajada_teto_segundos: "20" }), { silencioMs: 5000, tetoMs: 20000 });
  assertEquals(rajadaDoConfig({ rajada_silencio_segundos: "200", rajada_teto_segundos: "10" }), { silencioMs: 60000, tetoMs: 60000 });
  assertEquals(rajadaDoConfig({ rajada_silencio_segundos: "x", rajada_teto_segundos: "999" }), { silencioMs: 30000, tetoMs: 90000 });
});
