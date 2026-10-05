import { assertEquals } from "jsr:@std/assert";
import { senhaForte, validarNovoUsuario } from "./usuarios.ts";

const base = {
  acao: "criar",
  name: "Ana Paula",
  email: "  Ana@Clinica.com.br ",
  password: "Forte#2026x",
  perfil: "Vendedor",
};

Deno.test("senha forte aceita e fraca recusa", () => {
  assertEquals(senhaForte("Forte#2026x"), true);
  assertEquals(senhaForte("fraca"), false);
  assertEquals(senhaForte("SemSimbolo123"), false);
  assertEquals(senhaForte("sem#maiuscula1"), false);
  assertEquals(senhaForte("a".repeat(70) + "A1#x"), false); // acima de 72
});

Deno.test("normaliza e-mail e nome", () => {
  const r = validarNovoUsuario({ ...base, name: "  Ana Paula  " });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.dados.email, "ana@clinica.com.br");
    assertEquals(r.dados.name, "Ana Paula");
    assertEquals(r.dados.perfil_id, null);
  }
});

Deno.test("recusa e-mail invalido, nome vazio e senha fraca", () => {
  assertEquals(validarNovoUsuario({ ...base, email: "sem-arroba" }), { ok: false, erro: "payload_invalido" });
  assertEquals(validarNovoUsuario({ ...base, name: "  " }), { ok: false, erro: "payload_invalido" });
  assertEquals(validarNovoUsuario({ ...base, password: "12345678" }), { ok: false, erro: "senha_fraca" });
});

Deno.test("vendedores_responsaveis_ids precisa ser lista", () => {
  assertEquals(validarNovoUsuario({ ...base, vendedores_responsaveis_ids: "x" }), { ok: false, erro: "payload_invalido" });
  const r = validarNovoUsuario({ ...base, vendedores_responsaveis_ids: ["v1", ""] });
  assertEquals(r.ok && r.dados.vendedores_responsaveis_ids, ["v1"]);
});
