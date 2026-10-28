import { assertEquals } from "jsr:@std/assert";
import { consentimentoLibera, interpretarConsentimento, pedidoDeConversaAnterior, pedirConsentimento } from "./consentimento.ts";

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

Deno.test("resposta a 'Podemos seguir?' conta como autorizacao", () => {
  assertEquals(interpretarConsentimento("Podemos"), "sim");
  assertEquals(interpretarConsentimento("pode seguir"), "sim");
  assertEquals(interpretarConsentimento("pode continuar sim"), "sim");
  assertEquals(interpretarConsentimento("não podemos"), "nao");
});

Deno.test("pedido feito antes do encerramento da conversa vale como pedido antigo", () => {
  const inicio = Date.parse("2026-10-21T20:25:22Z");
  assertEquals(pedidoDeConversaAnterior("2026-10-15T20:35:46Z", inicio), true);
  assertEquals(pedidoDeConversaAnterior("2026-10-22T18:53:56Z", inicio), false);
  assertEquals(pedidoDeConversaAnterior("2026-10-15T20:35:46Z", NaN), false);
  assertEquals(pedidoDeConversaAnterior(null, inicio), false);
});

Deno.test("pedido de consulta no lugar do sim/nao fica ambiguo (vira lembrete)", () => {
  assertEquals(interpretarConsentimento("Olá, boa tarde. Gostaria de marcar uma consulta!"), "ambiguo");
});

Deno.test("pedido de autorizacao so com pedir_consentimento = 'true'", () => {
  assertEquals(pedirConsentimento({}), false);
  assertEquals(pedirConsentimento({ pedir_consentimento: "" }), false);
  assertEquals(pedirConsentimento({ pedir_consentimento: "false" }), false);
  assertEquals(pedirConsentimento({ pedir_consentimento: " TRUE " }), true);
});

Deno.test("lembrete: com pedido ligado so concedido; desligado so barra recusa", () => {
  const ligado = { pedir_consentimento: "true" };
  assertEquals(consentimentoLibera(ligado, "concedido"), true);
  assertEquals(consentimentoLibera(ligado, "pendente"), false);
  assertEquals(consentimentoLibera(ligado, null), false);
  assertEquals(consentimentoLibera({}, null), true);
  assertEquals(consentimentoLibera({}, "pendente"), true);
  assertEquals(consentimentoLibera({}, "negado"), false);
  assertEquals(consentimentoLibera({}, "revogado"), false);
});
