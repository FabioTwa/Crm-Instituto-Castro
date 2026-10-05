import { assertEquals, assert } from "jsr:@std/assert";
import { canonicoTelefone, soDigitos, telefoneBrPlausivel, variacoesTelefone } from "./telefone.ts";

Deno.test("soDigitos remove tudo que nao e digito", () => {
  assertEquals(soDigitos("+55 (11) 97806-4033"), "5511978064033");
  assertEquals(soDigitos(""), "");
});

Deno.test("canonico de numero formatado com 9", () => {
  assertEquals(canonicoTelefone("+55 (11) 97806-4033"), "5511978064033");
});

Deno.test("canonico acrescenta o 9 em celular antigo de 10 digitos", () => {
  assertEquals(canonicoTelefone("1178064033"), "5511978064033");
  assertEquals(canonicoTelefone("551178064033"), "5511978064033");
});

Deno.test("canonico ja canonico nao muda", () => {
  assertEquals(canonicoTelefone("5511978064033"), "5511978064033");
});

Deno.test("variacoes incluem com/sem DDI e com/sem 9", () => {
  const v = new Set(variacoesTelefone("5511978064033"));
  assert(v.has("5511978064033"));
  assert(v.has("11978064033"));
  assert(v.has("1178064033"));
  assert(v.has("551178064033"));
});

Deno.test("plausibilidade brasileira", () => {
  assert(telefoneBrPlausivel("5511978064033"));
  assert(telefoneBrPlausivel("551178064033"));
  assert(!telefoneBrPlausivel("11978064033"));
  assert(!telefoneBrPlausivel("5511978064033999"));
  assert(!telefoneBrPlausivel(""));
});

Deno.test("vazio devolve vazio", () => {
  assertEquals(canonicoTelefone(""), "");
  assertEquals(variacoesTelefone(""), []);
});
