import { assertEquals } from "jsr:@std/assert";
import { interpretarConsentimento } from "./consentimento.ts";

Deno.test("'sim, pode' -> sim", () => {
  assertEquals(interpretarConsentimento("sim, pode"), "sim");
});

Deno.test("variacoes de sim com acento e caixa", () => {
  assertEquals(interpretarConsentimento("CLARO!"), "sim");
  assertEquals(interpretarConsentimento("Tá bom"), "sim");
  assertEquals(interpretarConsentimento("ok"), "sim");
  assertEquals(interpretarConsentimento("Concordo."), "sim");
});

Deno.test("'nao' e 'prefiro nao' -> nao", () => {
  assertEquals(interpretarConsentimento("Não"), "nao");
  assertEquals(interpretarConsentimento("prefiro não"), "nao");
  assertEquals(interpretarConsentimento("NAO ACEITO"), "nao");
});

Deno.test("mensagem sem sinal -> ambiguo", () => {
  assertEquals(interpretarConsentimento("qual o endereço?"), "ambiguo");
  assertEquals(interpretarConsentimento(""), "ambiguo");
});

Deno.test("sim e nao juntos -> ambiguo", () => {
  assertEquals(interpretarConsentimento("sim, mas não agora"), "ambiguo");
});

Deno.test("'pode' sozinho conta como sim (limitacao documentada)", () => {
  // "pode me ligar?" nao e consentimento, mas o regex simples le como sim.
  // Por isso a mensagem de consentimento pede resposta curta SIM/NAO.
  assertEquals(interpretarConsentimento("pode"), "sim");
});

Deno.test("'nao' em frase longa negativa -> nao", () => {
  assertEquals(interpretarConsentimento("não quero atendimento automático, obrigado"), "nao");
});
