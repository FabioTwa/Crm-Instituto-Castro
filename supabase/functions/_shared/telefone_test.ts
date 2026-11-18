import { assertEquals, assert } from "jsr:@std/assert";
import { canonicoTelefone, soDigitos, telefoneBrPlausivel, telefonePlausivel, variacoesTelefone } from "./telefone.ts";

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

Deno.test("numero de fora do Brasil fica como veio, com o codigo do pais", () => {
  assertEquals(canonicoTelefone("447700900123"), "447700900123");      // Reino Unido
  assertEquals(canonicoTelefone("+1 (415) 555-2671"), "14155552671");  // EUA: 11 digitos sem 9 depois do "DDD"
  assertEquals(canonicoTelefone("351912345678"), "351912345678");      // Portugal
  assertEquals(canonicoTelefone("5491123456789"), "5491123456789");    // Argentina (54)
});

Deno.test("brasileiro continua igual", () => {
  assertEquals(canonicoTelefone("11978064033"), "5511978064033");
  assertEquals(canonicoTelefone("1178064033"), "5511978064033");
  assertEquals(canonicoTelefone("5511978064033"), "5511978064033");
  assertEquals(canonicoTelefone("551178064033"), "5511978064033");
});

Deno.test("telefone plausivel: Brasil e fora do Brasil", () => {
  assert(telefonePlausivel("5511978064033"));
  assert(telefonePlausivel("447700900123"));
  assert(telefonePlausivel("14155552671"));
  assert(telefonePlausivel("351912345678"));
  assert(!telefonePlausivel(""));
  assert(!telefonePlausivel("1234567"));             // curto demais
  assert(!telefonePlausivel("12345678901234"));      // 14 digitos: LID, nao telefone
  assert(!telefonePlausivel("0447700900123"));       // comeca com 0
  assert(!telefonePlausivel("55119780640"));         // 55 com tamanho errado
});
