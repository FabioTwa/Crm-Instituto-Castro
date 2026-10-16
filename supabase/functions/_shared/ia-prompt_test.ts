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
