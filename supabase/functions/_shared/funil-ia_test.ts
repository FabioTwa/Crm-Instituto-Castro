import { assertEquals } from "jsr:@std/assert";
import { detectarAgendamento, detectarNegociacao } from "./funil-ia.ts";

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

Deno.test("detectarAgendamento: lead pede para marcar ou fala de dia e horario", () => {
  assertEquals(detectarAgendamento("Quero marcar uma visita", ""), 'lead falou de agendamento ("marcar")');
  assertEquals(detectarAgendamento("Tem horário na quinta?", ""), 'lead falou de agendamento ("horario")');
  assertEquals(detectarAgendamento("Qual dia vocês atendem?", ""), 'lead falou de agendamento ("qual dia")');
});

Deno.test("detectarAgendamento: IA ofereceu data ou horario", () => {
  assertEquals(detectarAgendamento("sim", "Pode ser no dia 12/11 (quarta) às 15:00?"), "a IA ofereceu data ou horário");
  assertEquals(detectarAgendamento("ok", "Tenho às 9h ou às 14h, qual prefere?"), "a IA ofereceu data ou horário");
});

Deno.test("detectarAgendamento: conversa comum nao conta", () => {
  assertEquals(detectarAgendamento("Oi, bom dia", "Oi, tudo bem? Aqui é a Jully."), null);
  assertEquals(detectarAgendamento("Qual o valor?", "A avaliação inicial é R$ 150,00."), null);
  assertEquals(detectarAgendamento("quero emagrecer", "Entendi, há quanto tempo você pensa nisso?"), null);
  assertEquals(detectarAgendamento("Na segunda vez que tentei dieta não deu certo", "Entendo."), null);
  assertEquals(detectarAgendamento("Minha agenda anda corrida", "Imagino."), null);
});
