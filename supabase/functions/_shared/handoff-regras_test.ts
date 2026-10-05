import { assertEquals } from "jsr:@std/assert";
import { detectarHandoff } from "./handoff-regras.ts";

Deno.test("urgencia com acento e caixa alta", () => {
  assertEquals(detectarHandoff("Estou com DOR FORTE e FALTA DE AR")?.motivo, "urgencia");
  assertEquals(detectarHandoff("É urgência!")?.motivo, "urgencia");
});

Deno.test("urgencia vence duvida clinica quando as duas aparecem", () => {
  assertEquals(detectarHandoff("tomei o remedio e estou vomitando sangue")?.motivo, "urgencia");
});

Deno.test("duvida clinica: dose, mg e nome de caneta", () => {
  assertEquals(detectarHandoff("Qual a dose certa?")?.motivo, "duvida_clinica");
  assertEquals(detectarHandoff("Posso tomar 2,5 mg?")?.motivo, "duvida_clinica");
  assertEquals(detectarHandoff("Vocês trabalham com Mounjaro?")?.motivo, "duvida_clinica");
  assertEquals(detectarHandoff("Posso tomar junto com o anticoncepcional?")?.motivo, "duvida_clinica");
});

Deno.test("reclamacao e pedido de humano", () => {
  assertEquals(detectarHandoff("Isso é um ABSURDO, vou no Procon")?.motivo, "reclamacao");
  assertEquals(detectarHandoff("quero falar com uma pessoa")?.motivo, "pedido_humano");
  assertEquals(detectarHandoff("vc é um robô?")?.motivo, "pedido_humano");
  assertEquals(detectarHandoff("me passa pra um atendente")?.motivo, "pedido_humano");
});

Deno.test("falso-positivo: negacao simples nao dispara", () => {
  assertEquals(detectarHandoff("não é urgente, só queria saber o horário"), null);
  assertEquals(detectarHandoff("estou sem dor forte hoje"), null);
});

Deno.test("mensagem neutra nao dispara nada", () => {
  assertEquals(detectarHandoff("Oi, quero agendar uma avaliação para bariátrica"), null);
  assertEquals(detectarHandoff("Qual o endereço de vocês?"), null);
  assertEquals(detectarHandoff("Aceitam convênio?"), null);
  assertEquals(detectarHandoff(""), null);
});

Deno.test("botao nao e bot (fronteira de palavra)", () => {
  assertEquals(detectarHandoff("cliquei no botão errado"), null);
});
