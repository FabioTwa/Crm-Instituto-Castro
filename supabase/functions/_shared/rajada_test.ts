import { assertEquals } from "jsr:@std/assert@1";
import { decidirRajada } from "./rajada.ts";

const t0 = Date.parse("2026-10-16T17:00:00.000Z");
const msg = (id: string, ms: number) => ({ id, criada_em: new Date(t0 + ms).toISOString() });

Deno.test("mensagem mais nova do lead: a invocacao antiga desiste", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("b", 500), agoraMs: t0 + 1000, inicioEsperaMs: t0 }), { acao: "absorvida" });
});

Deno.test("pessoa ainda digitando: espera completar 3 s de silencio", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 0), agoraMs: t0 + 1000, inicioEsperaMs: t0 + 1000 }), { acao: "esperar", ms: 2000 });
});

Deno.test("3 s sem mensagem nova: responde", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 0), agoraMs: t0 + 3000, inicioEsperaMs: t0 }), { acao: "responder" });
});

Deno.test("teto: nunca segura mais que 12 s desde o inicio da espera", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: msg("a", 11500), agoraMs: t0 + 12500, inicioEsperaMs: t0 }), { acao: "responder" });
});

Deno.test("sem leitura da ultima mensagem: responde (nao trava a IA)", () => {
  assertEquals(decidirRajada({ gatilhoId: "a", ultimaDoLead: null, agoraMs: t0, inicioEsperaMs: t0 }), { acao: "responder" });
});
