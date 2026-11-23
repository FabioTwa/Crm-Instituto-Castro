import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  diaLocal, horaDoAvisoGrupo, interpretarRespostaGrupo, MAX_ITENS_POR_LISTA, montarPendencias, numerosMarcados,
  type Pendencia, textoMarcacoes, textoPendenciasGrupo,
} from "./grupo-pendencias.ts";
import { corpoTextoZapi, destinoZapi } from "./zapi.ts";

// Segunda, 23/11/2026 13h em Sao Paulo (16h UTC).
const AGORA = new Date("2026-11-23T16:00:00Z");

const cards = [
  { id: "c-diana", nome: "Diana 1343", telefone: "5511900001343", etapa: "agendamento_pendente" },
  { id: "c-cida", nome: "Cida Torres 0101", telefone: "5511900000101", etapa: "agendamento_pendente" },
  { id: "c-andreia", nome: "Andreia 9696", telefone: "5511900009696", etapa: "agendamento_pendente" },
  { id: "c-ariana", nome: "Ariana 👑 6777", telefone: "5511900006777", etapa: "agendamento_pendente" },
  { id: "c-movido", nome: "Bia", telefone: "5511900005555", etapa: "visita_confirmada" },
  { id: "c-casa", nome: "Fabio", telefone: "5511916863913", etapa: "agendamento_pendente" },
];
const agendamentos = [
  { id: "a-cida", cliente_crm_id: "c-cida", inicio: "2026-11-24T17:30:00Z" },
  { id: "a-diana", cliente_crm_id: "c-diana", inicio: "2026-11-24T17:00:00Z" },
  { id: "a-passado", cliente_crm_id: "c-andreia", inicio: "2026-11-19T17:30:00Z" },
];
const pedidos = [
  { cliente_crm_id: "c-diana", criado_em: "2026-11-18T20:54:00Z" },
  { cliente_crm_id: "c-andreia", criado_em: "2026-11-20T16:23:00Z" },
  { cliente_crm_id: "c-ariana", criado_em: "2026-11-23T15:35:00Z" }, // hoje
  { cliente_crm_id: "c-movido", criado_em: "2026-11-20T10:00:00Z" },
  { cliente_crm_id: "c-casa", criado_em: "2026-11-20T10:00:00Z" },
];

function lista(incluirHoje = false): Pendencia[] {
  return montarPendencias({ agora: AGORA, cards, agendamentos, pedidos, ignorar: ["5511916863913"], incluirPedidosDeHoje: incluirHoje });
}

Deno.test("pendencias: confirmar (futuro, por horario) e agendar (antes de hoje, card ainda pendente)", () => {
  const p = lista();
  assertEquals(p.map((x) => `${x.tipo}:${x.nome}:${x.final}`), [
    "confirmar:Diana:1343",
    "confirmar:Cida:0101",
    "agendar:Andreia:9696",
  ]);
  assertEquals(p[0].agendamentoId, "a-diana");
});

Deno.test("pendencias: pedido de hoje so entra para ler a resposta", () => {
  assert(!lista().some((x) => x.clienteId === "c-ariana"));
  const p = lista(true).find((x) => x.clienteId === "c-ariana");
  assertEquals(p?.nome, "Ariana");
});

Deno.test("pendencias: numero da casa e card ja movido ficam de fora", () => {
  const ids = lista(true).map((x) => x.clienteId);
  assert(!ids.includes("c-casa"));
  assert(!ids.includes("c-movido"));
});

Deno.test("texto do grupo: se identifica como IA, so primeiro nome e final, sem assunto", () => {
  const t = textoPendenciasGrupo(lista(), AGORA)!;
  assert(t.includes("Aqui é a Jully, a inteligência artificial"));
  assert(t.includes("• Diana (final 1343): amanhã, 24/11, às 14h00"));
  assert(t.includes("• Cida (final 0101): amanhã, 24/11, às 14h30"));
  assert(t.includes("• Andreia (final 9696): pediu em 20/11"));
  assert(t.includes('"Diana confirmada"'));
  assert(!t.includes("Torres"));
  assert(!/5511/.test(t));
});

Deno.test("texto do grupo: nada pendente = nada enviado", () => {
  assertEquals(textoPendenciasGrupo([], AGORA), null);
});

Deno.test("texto do grupo: lista longa corta com 'e mais'", () => {
  const muitos: Pendencia[] = Array.from({ length: MAX_ITENS_POR_LISTA + 3 }, (_, i) => ({
    tipo: "agendar", clienteId: "x" + i, agendamentoId: null, nome: "P" + i, final: "", quando: "2026-11-20T12:00:00Z",
  }));
  const t = textoPendenciasGrupo(muitos, AGORA)!;
  assert(t.includes("• e mais 3 no CRM"));
});

Deno.test("resposta: 'Diana confirmada' marca so a Diana", () => {
  assertEquals(interpretarRespostaGrupo("Diana confirmada", lista()).map((p) => p.clienteId), ["c-diana"]);
});

Deno.test("resposta: varios nomes, acento e maiusculas", () => {
  const r = interpretarRespostaGrupo("DIANA e Cida já estão CONFIRMADAS 👍", lista());
  assertEquals(r.map((p) => p.clienteId).sort(), ["c-cida", "c-diana"]);
});

Deno.test("resposta: pelo final do telefone", () => {
  assertEquals(interpretarRespostaGrupo("a do final 9696 agendou para sexta", lista()).map((p) => p.clienteId), ["c-andreia"]);
});

Deno.test("resposta: negacao no trecho barra aquele nome e deixa o outro", () => {
  const r = interpretarRespostaGrupo("Diana confirmada, Cida ainda não respondeu", lista());
  assertEquals(r.map((p) => p.clienteId), ["c-diana"]);
});

Deno.test("resposta: sem palavra de feito, intencao ou duvida nao mexe", () => {
  for (const t of [
    "Diana", "vou ligar para a Diana", "precisa agendar a Andreia", "Diana não confirmou",
    "Cida desmarcou", "Andreia vai confirmar amanhã", "alguém viu a Diana?", "Diana cancelou",
  ]) {
    assertEquals(interpretarRespostaGrupo(t, lista()), [], t);
  }
});

Deno.test("resposta: nome que nao esta na lista nao mexe; nome dentro de outra palavra tambem nao", () => {
  assertEquals(interpretarRespostaGrupo("Mariana confirmada", lista()), []);
  assertEquals(interpretarRespostaGrupo("Dianara confirmada", lista()), []);
});

Deno.test("resposta: nome repetido na lista so vale com o final", () => {
  const dup: Pendencia[] = [
    { tipo: "agendar", clienteId: "a1", agendamentoId: null, nome: "Ana", final: "1111", quando: "2026-11-20T12:00:00Z" },
    { tipo: "agendar", clienteId: "a2", agendamentoId: null, nome: "Ana", final: "2222", quando: "2026-11-20T12:00:00Z" },
  ];
  assertEquals(interpretarRespostaGrupo("Ana agendada", dup), []);
  assertEquals(interpretarRespostaGrupo("Ana 2222 agendada", dup).map((p) => p.clienteId), ["a2"]);
});

Deno.test("hora do aviso: seg-sab a partir da hora, antes das 20h; domingo nunca", () => {
  assert(!horaDoAvisoGrupo(new Date("2026-11-23T11:59:00Z"), 9)); // 08h59
  assert(horaDoAvisoGrupo(new Date("2026-11-23T12:00:00Z"), 9)); // 09h00
  assert(horaDoAvisoGrupo(new Date("2026-11-23T22:59:00Z"), 9)); // 19h59
  assert(!horaDoAvisoGrupo(new Date("2026-11-23T23:00:00Z"), 9)); // 20h
  assert(!horaDoAvisoGrupo(new Date("2026-11-22T13:00:00Z"), 9)); // domingo
  assert(horaDoAvisoGrupo(new Date("2026-11-28T13:00:00Z"), 9)); // sabado
});

Deno.test("dia local vira a meia-noite de Sao Paulo, nao a do UTC", () => {
  assertEquals(diaLocal(new Date("2026-11-24T02:30:00Z")), "2026-11-23");
  assertEquals(diaLocal(new Date("2026-11-24T03:30:00Z")), "2026-11-24");
});

Deno.test("destino Z-API: id de grupo segue intacto; telefone vira digitos", () => {
  assertEquals(destinoZapi("120363430917528427-group"), "120363430917528427-group");
  assertEquals(destinoZapi("+55 (11) 91184-4992"), "5511911844992");
});

Deno.test("marcacoes: aceita DDD+numero, com ou sem 55, sem repetir", () => {
  assertEquals(numerosMarcados("11954580790, 11963201355"), ["5511954580790", "5511963201355"]);
  assertEquals(numerosMarcados("+55 (11) 95458-0790;5511954580790"), ["5511954580790"]);
  assertEquals(numerosMarcados(""), []);
  assertEquals(textoMarcacoes(["5511954580790", "5511963201355"]), "@5511954580790 @5511963201355");
});

Deno.test("texto do grupo: com marcacao, o @ entra no texto", () => {
  const t = textoPendenciasGrupo(lista(), AGORA, ["5511954580790", "5511963201355"])!;
  assert(t.includes("@5511954580790 @5511963201355, passando para lembrar o que está aguardando o time:"));
  const sem = textoPendenciasGrupo(lista(), AGORA)!;
  assert(sem.includes("\nPassando para lembrar"));
});

Deno.test("corpo Z-API: mencionados vai em mentioned; sem mencao nao manda o campo", () => {
  assertEquals(corpoTextoZapi("120363430917528427-group", "@5511954580790 oi", undefined, ["5511954580790"]), {
    phone: "120363430917528427-group", message: "@5511954580790 oi", mentioned: ["5511954580790"],
  });
  assertEquals(corpoTextoZapi("5511999990000", "Oi", 3, []), { phone: "5511999990000", message: "Oi", delayTyping: 3 });
});
