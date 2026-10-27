import { assert, assertEquals } from "jsr:@std/assert";
import { canalDaLinha, modeloValido, provedorDaLinha } from "./whatsapp-envio.ts";

const env = (vals: Record<string, string>) => (n: string) => vals[n];

Deno.test("linha sem provedor vale como meta; provedor fora de uso nao tem canal", () => {
  assertEquals(provedorDaLinha({ meta_phone_id: "1" }), "meta");
  assertEquals(provedorDaLinha({ provedor: "GUPSHUP" }), null);
  assertEquals(provedorDaLinha(null), "meta");
});

Deno.test("canal meta: precisa de meta_phone_id e META_ACCESS_TOKEN", () => {
  const ok = canalDaLinha({ provedor: "meta", meta_phone_id: "PN1" }, env({ META_ACCESS_TOKEN: "t" }));
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.canal, { provedor: "meta", phoneId: "PN1", token: "t" });
  const semToken = canalDaLinha({ provedor: "meta", meta_phone_id: "PN1" }, env({}));
  assertEquals(semToken, { ok: false, provedor: "meta", motivo: "sem_credencial" });
  const semId = canalDaLinha({ provedor: "meta" }, env({ META_ACCESS_TOKEN: "t" }));
  assertEquals(semId, { ok: false, provedor: "meta", motivo: "numero_incompleto" });
});

Deno.test("linha antiga do Gupshup (removido) nunca envia, nem com credencial de outro provedor", () => {
  const linha = { provedor: "gupshup", gupshup_app: "IntegracaoCRM", numero_whatsapp: "+55 (11) 99999-0000", meta_phone_id: "PN1" };
  const todos = env({ GUPSHUP_API_KEY: "k", META_ACCESS_TOKEN: "t", ZAPI_INSTANCE_TOKEN: "tk", ZAPI_CLIENT_TOKEN: "ct" });
  assertEquals(canalDaLinha(linha, todos), { ok: false, provedor: null, motivo: "numero_incompleto" });
});

Deno.test("sem linha: sem_numero", () => {
  assertEquals(canalDaLinha(null, env({})), { ok: false, provedor: null, motivo: "sem_numero" });
});

Deno.test("modelo: Meta exige name", () => {
  const meta = { provedor: "meta" as const, phoneId: "p", token: "t" };
  assert(modeloValido(meta, { name: "boas_vindas" }));
  assert(!modeloValido(meta, {}));
});

Deno.test("canal zapi: precisa de zapi_instancia e dos dois tokens nos segredos", () => {
  assertEquals(provedorDaLinha({ provedor: "ZAPI" }), "zapi");
  const linha = { provedor: "zapi", zapi_instancia: " INST1 ", zapi_token: "nao-usado" };
  const ok = canalDaLinha(linha, env({ ZAPI_INSTANCE_TOKEN: "tk", ZAPI_CLIENT_TOKEN: "ct" }));
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.canal, { provedor: "zapi", instancia: "INST1", token: "tk", clientToken: "ct" });
  assertEquals(canalDaLinha(linha, env({ ZAPI_INSTANCE_TOKEN: "tk" })), { ok: false, provedor: "zapi", motivo: "sem_credencial" });
  assertEquals(
    canalDaLinha({ provedor: "zapi" }, env({ ZAPI_INSTANCE_TOKEN: "tk", ZAPI_CLIENT_TOKEN: "ct" })),
    { ok: false, provedor: "zapi", motivo: "numero_incompleto" },
  );
});

Deno.test("modelo: Z-API nunca envia modelo", () => {
  const z = { provedor: "zapi" as const, instancia: "i", token: "t", clientToken: "c" };
  assertEquals(modeloValido(z, { name: "x" }), false);
});
