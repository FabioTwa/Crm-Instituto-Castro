import { assert, assertEquals } from "jsr:@std/assert";
import { canalDaLinha, modeloValido, provedorDaLinha } from "./whatsapp-envio.ts";

const env = (vals: Record<string, string>) => (n: string) => vals[n];

Deno.test("linha sem coluna provedor (antes do SQL 28) vale como meta", () => {
  assertEquals(provedorDaLinha({ meta_phone_id: "1" }), "meta");
  assertEquals(provedorDaLinha({ provedor: "GUPSHUP" }), "gupshup");
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

Deno.test("canal gupshup: precisa de app, numero e GUPSHUP_API_KEY; nao usa o token da Meta", () => {
  const linha = { provedor: "gupshup", gupshup_app: "IntegracaoCRM", numero_whatsapp: "+55 (11) 99999-0000" };
  const ok = canalDaLinha(linha, env({ GUPSHUP_API_KEY: "k" }));
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.canal, { provedor: "gupshup", app: "IntegracaoCRM", origem: "5511999990000", apiKey: "k" });
  assertEquals(canalDaLinha(linha, env({ META_ACCESS_TOKEN: "t" })), { ok: false, provedor: "gupshup", motivo: "sem_credencial" });
  assertEquals(
    canalDaLinha({ ...linha, gupshup_app: "" }, env({ GUPSHUP_API_KEY: "k" })),
    { ok: false, provedor: "gupshup", motivo: "numero_incompleto" },
  );
});

Deno.test("sem linha: sem_numero", () => {
  assertEquals(canalDaLinha(null, env({})), { ok: false, provedor: null, motivo: "sem_numero" });
});

Deno.test("modelo: Meta exige name, Gupshup exige id", () => {
  const meta = { provedor: "meta" as const, phoneId: "p", token: "t" };
  const gs = { provedor: "gupshup" as const, app: "a", origem: "5511999990000", apiKey: "k" };
  assert(modeloValido(meta, { name: "boas_vindas" }));
  assert(!modeloValido(meta, { id: "uuid" }));
  assert(modeloValido(gs, { id: "uuid" }));
  assert(!modeloValido(gs, { name: "boas_vindas" }));
});
