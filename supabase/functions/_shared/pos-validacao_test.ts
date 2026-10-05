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
