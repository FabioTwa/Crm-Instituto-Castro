import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { dataHoraLocal, numerosAviso, telefoneLegivel, textoAvisoAgendamento, textoAvisoCancelamento, textoAvisoCentral } from "./aviso-agendamento.ts";

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

Deno.test("aviso de agendamento por convenio pede a verificacao de elegibilidade", () => {
  const base = { nome: "Ana", telefone: "5511999998888", servico: "Cirurgia bariátrica", inicioIso: "2026-11-03T13:00:00.000Z" };
  assertStringIncludes(textoAvisoAgendamento({ ...base, pagamento: "Convênio Amil 400" }), "Verificar a elegibilidade do convênio");
  assertEquals(textoAvisoAgendamento({ ...base, pagamento: "Particular" }).includes("elegibilidade"), false);
});

Deno.test("pedido para a central de agendamento", () => {
  const t = textoAvisoCentral({ nome: "Ana", telefone: "5511999998888", assunto: "cirurgia_convenio_nao_atendido", convenio: "Hapvida Nosso Plano", procedimento: "vesícula", resumo: "" });
  assertStringIncludes(t, "*Pedido para a central de agendamento*");
  assertStringIncludes(t, "*Convênio/plano:* Hapvida Nosso Plano");
  assertStringIncludes(t, "*Cirurgia:* vesícula");
  assertStringIncludes(t, "(11) 99999-8888");
});

Deno.test("aviso de remarcacao mostra o horario anterior e o novo", () => {
  const t = textoAvisoAgendamento({
    nome: "Thamires", telefone: "5511999999727", servico: "Consulta de avaliação",
    inicioIso: "2026-11-19T13:00:00Z", inicioAnteriorIso: "2026-11-19T12:00:00Z", atualizado: true,
  });
  assertStringIncludes(t, "remarcado");
  assertStringIncludes(t, "*Antes:* 19/11 (quinta-feira) às 09:00");
  assertStringIncludes(t, "*Agora:* 19/11 (quinta-feira) às 10:00");
});

Deno.test("pre-agendamento: modo so liga com 'true'", async () => {
  const { modoPreAgendamento } = await import("./aviso-agendamento.ts");
  assertEquals(modoPreAgendamento({}), false);
  assertEquals(modoPreAgendamento({ modo_pre_agendamento: "false" }), false);
  assertEquals(modoPreAgendamento({ modo_pre_agendamento: " TRUE " }), true);
  assertEquals(modoPreAgendamento(null), false);
});

Deno.test("pre-agendamento: rodizio do call center e estavel por card e espalha", async () => {
  const { numeroCallCenterDoLead } = await import("./aviso-agendamento.ts");
  assertEquals(numeroCallCenterDoLead([], "abc"), null);
  assertEquals(numeroCallCenterDoLead(["5511911112222"], "qualquer"), "5511911112222");
  const nums = ["5511911112222", "5511933334444", "5511955556666"];
  const a = numeroCallCenterDoLead(nums, "card-1");
  assertEquals(numeroCallCenterDoLead(nums, "card-1"), a);
  const usados = new Set<string>();
  for (let i = 0; i < 60; i++) usados.add(String(numeroCallCenterDoLead(nums, crypto.randomUUID())));
  assertEquals(usados.size, 3);
});

Deno.test("time de agendamento: pedido traz dados, resumo, link e termina em Aguardando agendamento", async () => {
  const { textoPedidoAgendamento } = await import("./aviso-agendamento.ts");
  const t = textoPedidoAgendamento({
    nome: "Maria Souza", telefone: "5511988887777", servico: "Gastroenterologia",
    formato: "Presencial", pagamento: "Convênio Bradesco Top", preferencia: "terças à tarde",
    resumo: "Quer consulta de gastro.", linkCrm: "https://crm.exemplo/#card=1",
  });
  assertStringIncludes(t, "Novo pedido de agendamento pela Jully");
  assertStringIncludes(t, "*Nome:* Maria Souza");
  assertStringIncludes(t, "(11) 98888-7777");
  assertStringIncludes(t, "*Pagamento:* Convênio Bradesco Top");
  assertStringIncludes(t, "*Preferência:* terças à tarde");
  assertStringIncludes(t, "*Resumo da conversa:* Quer consulta de gastro.");
  assertStringIncludes(t, "https://crm.exemplo/#card=1");
  assert(t.trimEnd().endsWith("⏳ *Aguardando agendamento*"));
  assertEquals(t.includes("elegibilidade"), false);
  assertEquals(t.includes("*Data:*"), false);
  const vazio = textoPedidoAgendamento({ nome: "", telefone: "5511988887777", servico: "" });
  assertStringIncludes(vazio, "*Pagamento:* não informado");
  assertEquals(vazio.includes("Preferência"), false);
});

Deno.test("time de agendamento: destinos = avisos + call center, sem repetir", async () => {
  const { destinosPedidoAgendamento } = await import("./aviso-agendamento.ts");
  assertEquals(destinosPedidoAgendamento(["5511911111111", "5511922222222"], null), ["5511911111111", "5511922222222"]);
  assertEquals(destinosPedidoAgendamento(["5511911111111"], "5511933333333"), ["5511911111111", "5511933333333"]);
  assertEquals(destinosPedidoAgendamento(["5511911111111"], "5511911111111"), ["5511911111111"]);
  assertEquals(destinosPedidoAgendamento([], null), []);
});

Deno.test("numero do call center fixo: (11) 2020-8098 fica com 12 digitos e legivel", () => {
  assertEquals(numerosAviso("1120208098"), ["551120208098"]);
  assertEquals(telefoneLegivel("551120208098"), "(11) 2020-8098");
});
