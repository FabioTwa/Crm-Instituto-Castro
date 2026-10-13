import { assertEquals } from "jsr:@std/assert";
import { faseTeste, numerosTeste } from "./ia-teste.ts";

Deno.test("numerosTeste normaliza, ignora lixo e duplicados", () => {
  assertEquals(numerosTeste("(11) 97806-4033; 5511978064033, abc\n1178064033"), ["5511978064033"]);
  assertEquals(numerosTeste(""), []);
  assertEquals(numerosTeste(null), []);
});

Deno.test("sem configuracao: sombra ligada e atende todos", () => {
  assertEquals(faseTeste({}, "5511978064033"), { atende: true, sombra: true, restrito: false });
});

Deno.test("so 'false' desliga o modo sombra", () => {
  assertEquals(faseTeste({ modo_sombra: "false" }, "5511978064033").sombra, false);
  assertEquals(faseTeste({ modo_sombra: " FALSE " }, "5511978064033").sombra, false);
  assertEquals(faseTeste({ modo_sombra: "nao" }, "5511978064033").sombra, true);
});

Deno.test("lista de teste restringe aos numeros listados", () => {
  const cfg = { numeros_teste: "11 97806-4033" };
  assertEquals(faseTeste(cfg, "+55 11 97806-4033").atende, true);
  assertEquals(faseTeste(cfg, "5511912345678").atende, false);
  assertEquals(faseTeste(cfg, "5511912345678").restrito, true);
});
