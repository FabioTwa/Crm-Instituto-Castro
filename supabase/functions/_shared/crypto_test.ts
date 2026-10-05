import { assertEquals, assert, assertRejects } from "jsr:@std/assert";
import { assinarToken, cifrar, decifrar, iguaisTempoConstante, verificarToken } from "./crypto.ts";

// 32 bytes zero em base64 (so para teste).
const CHAVE = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

Deno.test("cifrar e decifrar devolve o texto original (com acento)", async () => {
  const env = await cifrar("1//refresh-token-ção-ãé", CHAVE);
  assert(env.startsWith("v1."));
  assertEquals(await decifrar(env, CHAVE), "1//refresh-token-ção-ãé");
});

Deno.test("dois cifrados do mesmo texto sao diferentes (iv aleatorio)", async () => {
  const a = await cifrar("x", CHAVE);
  const b = await cifrar("x", CHAVE);
  assert(a !== b);
});

Deno.test("chave errada nao decifra", async () => {
  const outra = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const env = await cifrar("segredo", CHAVE);
  await assertRejects(() => decifrar(env, outra));
});

Deno.test("chave com tamanho errado e recusada", async () => {
  await assertRejects(() => cifrar("x", btoa("curta")));
});

Deno.test("token assinado verifica e carrega o payload", async () => {
  const t = await assinarToken({ user_id: "abc" }, "segredo-teste", 60);
  const p = await verificarToken(t, "segredo-teste");
  assertEquals(p?.user_id, "abc");
});

Deno.test("token com segredo errado ou adulterado falha", async () => {
  const t = await assinarToken({ user_id: "abc" }, "segredo-teste", 60);
  assertEquals(await verificarToken(t, "outro"), null);
  assertEquals(await verificarToken(t.slice(0, -2) + "zz", "segredo-teste"), null);
  assertEquals(await verificarToken("lixo", "segredo-teste"), null);
});

Deno.test("token expirado falha", async () => {
  const t = await assinarToken({ user_id: "abc" }, "segredo-teste", -10);
  assertEquals(await verificarToken(t, "segredo-teste"), null);
});

Deno.test("comparacao em tempo constante", () => {
  assert(iguaisTempoConstante("abc", "abc"));
  assert(!iguaisTempoConstante("abc", "abd"));
  assert(!iguaisTempoConstante("", ""));
});
