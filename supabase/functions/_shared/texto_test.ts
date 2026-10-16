import { assertEquals } from "jsr:@std/assert";
import { assinarMensagem } from "./texto.ts";

Deno.test("assinatura: nome em negrito e mensagem na linha de baixo", () => {
  assertEquals(assinarMensagem("Gabriel", "Boa tarde"), "*Gabriel*\nBoa tarde");
});

Deno.test("assinatura: sem nome, mensagem sem assinatura", () => {
  assertEquals(assinarMensagem(null, "Oi"), "Oi");
  assertEquals(assinarMensagem("  ", "Oi"), "Oi");
  assertEquals(assinarMensagem("**", "Oi"), "Oi");
});

Deno.test("assinatura: nome sem marcadores nem quebras de linha", () => {
  assertEquals(assinarMensagem(" Ana *Paula*\n_Souza_ ", "Oi"), "*Ana Paula Souza*\nOi");
});

Deno.test("assinatura: passaria do limite, segue sem assinatura", () => {
  const longo = "x".repeat(4090);
  assertEquals(assinarMensagem("Gabriel", longo), longo);
  assertEquals(assinarMensagem("Gabriel", "Oi", 12), "*Gabriel*\nOi");
  assertEquals(assinarMensagem("Gabriel", "Oi", 11), "Oi");
});
