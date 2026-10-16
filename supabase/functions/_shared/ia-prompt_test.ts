import { assertEquals } from "jsr:@std/assert@1";
import { calendarioDiasUteis, montarSystemPrompt, paraWhatsApp } from "./ia-prompt.ts";

Deno.test("paraWhatsApp troca markdown pela formatacao do WhatsApp", () => {
  assertEquals(paraWhatsApp("Nossa **Assessoria em Emagrecimento**!"), "Nossa *Assessoria em Emagrecimento*!");
  assertEquals(paraWhatsApp("## Valores\n- *Honorários:* particulares"), "Valores\n• *Honorários:* particulares");
  assertEquals(paraWhatsApp("Olá\n\n\n\nTudo bem?"), "Olá\n\nTudo bem?");
  assertEquals(paraWhatsApp("*Já* no padrão"), "*Já* no padrão");
});

Deno.test("calendarioDiasUteis pula sabado e domingo e acerta o dia da semana", () => {
  // 16/10/2026 e sexta-feira
  assertEquals(calendarioDiasUteis(2026, 10, 16, 3), ["16/10 (sexta-feira)", "19/10 (segunda-feira)", "20/10 (terça-feira)"]);
  // comecando num sabado
  assertEquals(calendarioDiasUteis(2026, 10, 17, 1), ["19/10 (segunda-feira)"]);
  // virada de ano
  assertEquals(calendarioDiasUteis(2026, 12, 31, 2), ["31/12 (quinta-feira)", "01/01 (sexta-feira)"]);
});

Deno.test("system prompt leva o calendario quando informado", () => {
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x", calendario: ["19/10 (segunda-feira)"] });
  assertEquals(sp.includes("19/10 (segunda-feira)"), true);
});

Deno.test("textos fixos variados passam na pos-validacao e nao falam em robo", async () => {
  const { respostaProibida } = await import("./pos-validacao.ts");
  const m = await import("./ia-prompt.ts");
  const listas = [m.TEXTOS_AGENDAMENTO_ANOTADO, m.TEXTOS_AVISO_ESPERA, m.TEXTOS_CONSENTIMENTO_NEGADO, m.TEXTOS_ENCERRAMENTO, m.TEXTOS_HANDOFF_GENERICO, m.TEXTOS_RESPOSTA_BLOQUEADA];
  for (const lista of listas) {
    assertEquals(lista.length >= 3, true);
    for (const t of lista) {
      assertEquals(respostaProibida(t), null);
      assertEquals(/assistente virtual|robô|automátic/i.test(t), false);
    }
  }
  assertEquals(respostaProibida(m.textoPedidoConsentimento("")), null);
  assertEquals(/SIM ou NÃO/.test(m.textoPedidoConsentimento("")), false);
  assertEquals(/automática/.test(m.textoPedidoConsentimento("")), true);
});

Deno.test("sortear escolhe dentro da lista", async () => {
  const { sortear } = await import("./ia-prompt.ts");
  assertEquals(sortear(["a", "b", "c"], () => 0), "a");
  assertEquals(sortear(["a", "b", "c"], () => 0.999), "c");
  assertEquals(sortear(["a", "b", "c"], () => 1), "c");
});
