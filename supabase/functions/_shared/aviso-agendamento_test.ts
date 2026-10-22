import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { dataHoraLocal, numerosAviso, telefoneLegivel, textoAvisoAgendamento, textoAvisoCancelamento } from "./aviso-agendamento.ts";

Deno.test("numerosAviso: aceita lista, normaliza e tira repetidos e invalidos", () => {
  assertEquals(numerosAviso(""), []);
  assertEquals(numerosAviso("(11) 99999-8888, 5511999998888; 123"), ["5511999998888"]);
});

Deno.test("dataHoraLocal: horario de Sao Paulo com dia da semana", () => {
  assertEquals(dataHoraLocal("2026-10-27T13:30:00.000Z"), "27/10 (terça-feira) às 10:30");
});

Deno.test("telefoneLegivel", () => {
  assertEquals(telefoneLegivel("5511999998888"), "(11) 99999-8888");
});

Deno.test("texto do aviso tem nome, telefone, servico e data", () => {
  const t = textoAvisoAgendamento({
    nome: "Maria Teste",
    telefone: "5511999998888",
    servico: "Cirurgia bariátrica",
    inicioIso: "2026-10-27T13:30:00.000Z",
    formato: "Presencial",
    pagamento: "Convênio Porto Seguro",
  });
  assertStringIncludes(t, "Novo agendamento pela IA");
  assertStringIncludes(t, "*Nome:* Maria Teste");
  assertStringIncludes(t, "(11) 99999-8888");
  assertStringIncludes(t, "27/10 (terça-feira) às 10:30");
  assertStringIncludes(t, "*Pagamento:* Convênio Porto Seguro");
});

Deno.test("aviso de cancelamento tem nome, telefone, data e motivo", () => {
  const t = textoAvisoCancelamento({
    nome: "Maria Teste",
    telefone: "5511999998888",
    titulo: "Visita para conhecer o Instituto",
    inicioIso: "2026-10-27T13:30:00.000Z",
    motivo: "mudou de cidade",
  });
  assertStringIncludes(t, "cancelado pelo lead");
  assertStringIncludes(t, "Maria Teste");
  assertStringIncludes(t, "(11) 99999-8888");
  assertStringIncludes(t, "27/10 (terça-feira) às 10:30");
  assertStringIncludes(t, "mudou de cidade");
});
