import { assertEquals, assert } from "jsr:@std/assert";
import { respostaProibida } from "./pos-validacao.ts";

Deno.test("resposta limpa passa", () => {
  assertEquals(
    respostaProibida("Que bom falar com você! Atendemos na Mooca, de segunda a quinta das 8h às 19h. Prefere manhã ou tarde?"),
    null,
  );
});

Deno.test("dose e mg detectados", () => {
  assert(respostaProibida("A dose inicial costuma ser baixa")?.startsWith("dose:"));
  assert(respostaProibida("Começamos com 2,5 mg por semana")?.startsWith("mg:"));
});

Deno.test("nome de caneta detectado, com acento e caixa", () => {
  assert(respostaProibida("Trabalhamos com OZEMPIC e Mounjaro")?.startsWith("medicamento:"));
  assert(respostaProibida("Use 5 mg de tirzepatida")?.startsWith("mg:"));
  assert(respostaProibida("A dose de Mounjaro é de duas canetas")?.startsWith("dose:"));
});

Deno.test("promessa de resultado detectada", () => {
  assert(respostaProibida("Garantimos que você vai emagrecer 10kg")?.startsWith("garantia:"));
  assert(respostaProibida("Resultado garantido!") !== null);
});

Deno.test("afirmacao clinica 'voce tem' / 'voce esta com' detectada", () => {
  assert(respostaProibida("Pelo que você descreve, você tem gastrite")?.startsWith("voce_tem:"));
  assert(respostaProibida("Você está com refluxo")?.startsWith("voce_tem:"));
});

Deno.test("pergunta de atendimento com 'voce tem' NAO e bloqueada", () => {
  assertEquals(respostaProibida("Você tem preferência de horário, manhã ou tarde?"), null);
  assertEquals(respostaProibida("Você tem convênio? Posso verificar o seu."), null);
});

Deno.test("diagnostico e receita detectados", () => {
  assert(respostaProibida("O diagnóstico é hérnia de hiato")?.startsWith("diagnostico:"));
  assert(respostaProibida("Posso te passar a receita")?.startsWith("receita:"));
});

Deno.test("'imagem' nao bate em mg (fronteira de palavra)", () => {
  assertEquals(respostaProibida("Recebi a imagem, obrigado!"), null);
});

Deno.test("valor: so os confirmados pelo Instituto (R$ 500,00) passam", () => {
  assertEquals(respostaProibida("A avaliação inicial é *R$ 150,00* e dá pra parcelar."), "valor:r$ 150,00");
  assertEquals(respostaProibida("A cirurgia fica R$ 1.500,00."), "valor:r$ 1.500,00");
  assertEquals(respostaProibida("A consulta com o cirurgião tem o valor de R$ 500,00, com um retorno incluído em até 30 dias."), null);
  assertEquals(respostaProibida("O valor é de R$500, com parcelamento no cartão de crédito."), null);
  assertEquals(respostaProibida("Fica 500 reais a consulta."), null);
  assertEquals(respostaProibida("Fica 300 reais a consulta."), "valor:300 reais");
  assertEquals(respostaProibida("Os valores a gente conversa pessoalmente."), null);
  assertEquals(respostaProibida("A consulta tem retorno em até 30 dias."), null);
});

Deno.test("Mounjaro/tirzepatida: a resposta confirmada pelo Instituto passa", () => {
  assertEquals(respostaProibida("Sim! Trabalhamos com um programa de emagrecimento com acompanhamento médico. Para avaliar a indicação de Mounjaro/tirzepatida e definir a dose adequada, é necessário passar por uma consulta. Gostaria de agendar sua avaliação?"), null);
  assertEquals(respostaProibida("A dose é definida pelo médico na consulta."), null);
  assert(respostaProibida("Qual dose você usa hoje?")?.startsWith("dose:"));
});
