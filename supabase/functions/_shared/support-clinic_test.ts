import { assert, assertEquals } from "jsr:@std/assert";
import { textoAlertaFalha, validarChamado, validarImportacao } from "./support-clinic.ts";

Deno.test("importacao valida descarta o nome do paciente e campos desconhecidos", () => {
  const r = validarImportacao({
    acao: "importar",
    periodo: { ini: "2026-11-01", fim: "2026-12-31" },
    linhas: [
      { codigo: "123", telefone: "(11) 99575 - 1525", data: "25/11/2026 09:40 - 10:00", tipo: "Gastro", profissional: "Dr", agendado_por: "X", status: "Atendido", criado: "19/11/2026 - 09:57:36", paciente: "Fulana de Tal", origem: "Google" },
      { codigo: "", status: "Agendado" },
      { codigo: "9", status: "" },
      null,
    ],
  });
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.linhas.length, 1);
  assertEquals((r.linhas[0] as any).paciente, undefined);
  assertEquals((r.linhas[0] as any).origem, undefined);
  assertEquals(r.linhas[0].telefone, "(11) 99575 - 1525");
});

Deno.test("importacao recusa periodo invalido ou grande demais", () => {
  assertEquals(validarImportacao({ periodo: { ini: "2026-12-31", fim: "2026-11-01" }, linhas: [] }), { ok: false, erro: "periodo_invalido" });
  assertEquals(validarImportacao({ periodo: { ini: "2026-01-01", fim: "2026-12-31" }, linhas: [] }), { ok: false, erro: "periodo_invalido" });
  assertEquals(validarImportacao({ periodo: { ini: "2026-11-01", fim: "2026-12-31" }, linhas: "x" }), { ok: false, erro: "linhas_invalidas" });
  assertEquals(validarImportacao(null), { ok: false, erro: "payload_invalido" });
});

Deno.test("aviso de falha cita a etapa e corta o motivo", () => {
  const t = textoAlertaFalha("login", "x".repeat(500), new Date("2026-11-26T11:05:00Z"));
  assert(t.includes("entrar no Support Clinic"));
  assert(t.includes("26/11"));
  assert(t.includes("08:05"));
  assert(!t.includes("x".repeat(301)));
  assert(textoAlertaFalha("??", "", new Date()).includes("rodar o robô"));
});

Deno.test("status do chamado: limpa, corta e exige numero e status", () => {
  const agora = new Date("2026-11-27T10:30:00Z");
  const r = validarChamado({ chamado: "TT-001526", status: " Em  andamento ", ultima_atualizacao: "27/11/2026 09:12", respostas: "2", resumo: "y".repeat(400), extra: "x" }, agora);
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.chamado.status, "Em andamento");
  assertEquals(r.chamado.respostas, 2);
  assertEquals(r.chamado.resumo.length, 300);
  assertEquals(r.chamado.lido_em, "2026-11-27T10:30:00.000Z");
  assertEquals((r.chamado as any).extra, undefined);
  assertEquals(validarChamado({ chamado: "", status: "Novo" }, agora), { ok: false, erro: "chamado_invalido" });
  assertEquals(validarChamado(null, agora), { ok: false, erro: "payload_invalido" });
});
