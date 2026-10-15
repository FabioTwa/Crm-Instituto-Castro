import { assertEquals } from "jsr:@std/assert";
import { detectarNegociacao } from "./funil-ia.ts";

Deno.test("detectarNegociacao: valor, preco, convenio, formato", () => {
  assertEquals(detectarNegociacao("Qual o valor da consulta?"), "valor");
  assertEquals(detectarNegociacao("Quanto custa a avaliação?"), "quanto custa");
  assertEquals(detectarNegociacao("Vocês aceitam convênio?"), "convenio");
  assertEquals(detectarNegociacao("Tem como parcelar no cartão?"), "parcelar");
  assertEquals(detectarNegociacao("É presencial ou online?"), "presencial");
  assertEquals(detectarNegociacao("Qual o PREÇO?"), "preco");
});

Deno.test("detectarNegociacao: conversa comum nao conta", () => {
  assertEquals(detectarNegociacao("Oi, bom dia"), null);
  assertEquals(detectarNegociacao("Quero marcar uma avaliação para quinta"), null);
  assertEquals(detectarNegociacao("Pode ser às 15h"), null);
  assertEquals(detectarNegociacao(""), null);
  assertEquals(detectarNegociacao("valorizo muito o atendimento"), null);
});
