import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { calendarioDiasUteis, montarSystemPrompt, paraWhatsApp, partesDaResposta, TEXTOS_LEMBRETE_CONSENTIMENTO } from "./ia-prompt.ts";
import { respostaProibida } from "./pos-validacao.ts";

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
  const listas = [m.TEXTOS_AGENDAMENTO_ANOTADO, m.TEXTOS_CONFIRMACAO_ANOTADA, m.TEXTOS_AGENDAMENTO_FALHOU, m.TEXTOS_CONSENTIMENTO_NEGADO, m.TEXTOS_ENCERRAMENTO, m.TEXTOS_RESPOSTA_BLOQUEADA];
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

Deno.test("persona: Jully por padrao, nome e ficha da config, sem negar ser IA", () => {
  const base = { primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "quarta-feira, 21/10/2026 15:00" };
  const padrao = montarSystemPrompt(base);
  assert(padrao.includes("Você é a Jully"));
  assert(padrao.includes("NÃO negue"));
  assert(padrao.includes("não conta história de saúde sua"));
  const outra = montarSystemPrompt({ ...base, persona: { nome: "Ana", ficha: "Gosta de música." } });
  assert(outra.includes("Você é a Ana. Gosta de música."));
});

Deno.test("partesDaResposta: um paragrafo por mensagem, lista junto, no maximo 3", () => {
  assertEquals(partesDaResposta("Oi!"), ["Oi!"]);
  assertEquals(partesDaResposta("Que bom!\n\nQual dia fica melhor?"), ["Que bom!", "Qual dia fica melhor?"]);
  assertEquals(partesDaResposta("Funciona assim:\n\n• A\n• B\n\nQuer agendar?"), ["Funciona assim:\n\n• A\n• B", "Quer agendar?"]);
  assertEquals(partesDaResposta("a\n\nb\n\nc\n\nd"), ["a", "b", "c\n\nd"]);
  assertEquals(partesDaResposta("  \n\n "), []);
});

Deno.test("objetivo: conduz para conhecer o Instituto e so marca consulta se a pessoa quiser", () => {
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertStringIncludes(sp, "VIR CONHECER O INSTITUTO");
  assertStringIncludes(sp, "Visita para conhecer o Instituto");
  assertStringIncludes(sp, "TODA resposta termina com uma pergunta");
  assertStringIncludes(sp, "Não diga que a visita é gratuita");
  assertStringIncludes(sp, 'Nunca chame a visita de "sem compromisso"');
});

Deno.test("atendimento 100% autonomo: nenhum texto fixo nem o prompt promete equipe ou atendente", async () => {
  const m = await import("./ia-prompt.ts");
  const { RESPOSTA_URGENCIA } = await import("./handoff-regras.ts");
  const fixos = [
    ...m.TEXTOS_AGENDAMENTO_ANOTADO, ...m.TEXTOS_CONFIRMACAO_ANOTADA, ...m.TEXTOS_AGENDAMENTO_FALHOU, ...m.TEXTOS_CANCELAMENTO_FALHOU, ...m.TEXTOS_CONSENTIMENTO_NEGADO,
    ...m.TEXTOS_ENCERRAMENTO, ...m.TEXTOS_ERRO_TEMPORARIO, ...m.TEXTOS_RESPOSTA_BLOQUEADA, RESPOSTA_URGENCIA,
    m.textoPedidoConsentimento(""), m.textoForaDoHorario(),
  ];
  for (const t of fixos) assertEquals(/equipe|atendente|te retorna|vai retornar/i.test(t), false, t);
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertEquals(sp.includes("encaminhar_humano"), false);
  assertStringIncludes(sp, "O atendimento é 100% seu");
  assertEquals(m.FERRAMENTAS.map((f) => f.name).sort(), ["cancelar_agendamento", "confirmar_agendamento", "propor_agendamento"]);
});

Deno.test("cancelamento: acolhe, pergunta o motivo e tenta manter antes de cancelar", () => {
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertStringIncludes(sp, "# Cancelamento ou desistência");
  assertStringIncludes(sp, "NÃO cancele de primeira");
  assertStringIncludes(sp, "pergunte o motivo");
  assertStringIncludes(sp, "No máximo duas tentativas");
  assertStringIncludes(sp, "chame cancelar_agendamento");
});

Deno.test("ligacoes: acolhe quem quis ligar e segue por mensagem, sem prometer retorno", () => {
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertStringIncludes(sp, "# Ligações");
  assertStringIncludes(sp, "por aqui eu não consigo atender ligação");
  assertStringIncludes(sp, "Nunca prometa que alguém vai ligar para ela.");
});

Deno.test("lembrete de consentimento: acolhe, pede o ok e passa na pos-validacao", () => {
  for (const t of TEXTOS_LEMBRETE_CONSENTIMENTO) {
    assertStringIncludes(t, "atendimento automático");
    assertStringIncludes(t, "?");
    assertEquals(respostaProibida(t), null);
  }
});

Deno.test("confirmacao: quem confirma o lembrete tem o horario marcado como confirmado", () => {
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertStringIncludes(sp, "se ela confirmar, chame confirmar_agendamento");
});

Deno.test("paraWhatsApp tira emoji (so texto)", () => {
  assertEquals(paraWhatsApp("Aqui é a Jully, do Instituto Castro 😊 Que bom ter você!"), "Aqui é a Jully, do Instituto Castro Que bom ter você!");
  assertEquals(paraWhatsApp("Até lá 😊"), "Até lá");
  assertEquals(paraWhatsApp("Poxa 😕, esse horário saiu 👍🏽"), "Poxa, esse horário saiu");
  assertEquals(paraWhatsApp("Combinado ❤️!"), "Combinado!");
});
