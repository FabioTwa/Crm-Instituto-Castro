import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { calendarioDiasUteis, MAX_CARACTERES_BLOCO, montarSystemPrompt, paraWhatsApp, partesDaResposta, TEXTOS_LEMBRETE_CONSENTIMENTO, TEXTOS_VALOR_PESSOALMENTE } from "./ia-prompt.ts";
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

Deno.test("partesDaResposta: um paragrafo por mensagem, lista junto, no maximo 4", () => {
  assertEquals(partesDaResposta("Oi!"), ["Oi!"]);
  assertEquals(partesDaResposta("Que bom!\n\nQual dia fica melhor?"), ["Que bom!", "Qual dia fica melhor?"]);
  assertEquals(partesDaResposta("Funciona assim:\n\n• A\n• B\n\nQuer agendar?"), ["Funciona assim:\n\n• A\n• B", "Quer agendar?"]);
  assertEquals(partesDaResposta("a\n\nb\n\nc\n\nd"), ["a", "b", "c", "d"]);
  assertEquals(partesDaResposta("a\n\nb\n\nc\n\nd\n\ne"), ["a", "b", "c", "d\n\ne"]);
  assertEquals(partesDaResposta("  \n\n "), []);
});

Deno.test("objetivo: conduz para consulta com especialista; visita so se a pessoa pedir", () => {
  const sp = montarSystemPrompt({ primeiroNome: null, funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertStringIncludes(sp, "A condução leva a pessoa a uma CONSULTA");
  assertStringIncludes(sp, "Podemos agendar um horário com um dos nossos especialistas?");
  assertStringIncludes(sp, "Só se a pessoa pedir para apenas conhecer o Instituto");
  assertStringIncludes(sp, "Visita para conhecer o Instituto");
  assertStringIncludes(sp, "TODA resposta termina com uma pergunta");
  assertStringIncludes(sp, "Não diga que a visita é gratuita");
  assertStringIncludes(sp, 'nunca a chame de "sem compromisso"');
  assertEquals(sp.includes("VIR CONHECER O INSTITUTO"), false);
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
  assertStringIncludes(sp, "Por aqui eu não consigo atender ligações");
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

Deno.test("paraWhatsApp mantem emoji (padrao do Instituto)", () => {
  assertEquals(paraWhatsApp("Será um prazer receber você! 😊"), "Será um prazer receber você! 😊");
  assertEquals(paraWhatsApp("📍 Estamos na Av. Paes de Barros, 1378"), "📍 Estamos na Av. Paes de Barros, 1378");
});

Deno.test("textos de valor: sem numero e passam na pos-validacao", () => {
  for (const t of TEXTOS_VALOR_PESSOALMENTE) {
    assertEquals(respostaProibida(t), null, t);
    assertEquals(/\d/.test(t), false, t);
  }
});

Deno.test("partesDaResposta: paragrafo longo vira blocos curtos, quebrando entre frases", () => {
  const longo =
    "As vitaminas são importantes para o bom funcionamento do organismo, e a necessidade de reposição deve ser avaliada de forma individualizada. " +
    "No Instituto Castro, nossos especialistas avaliam suas necessidades. Estamos na Av. Paes de Barros, 1378. Gostaria de agendar?";
  const partes = partesDaResposta(longo);
  assertEquals(partes, [
    "As vitaminas são importantes para o bom funcionamento do organismo, e a necessidade de reposição deve ser avaliada de forma individualizada.",
    "No Instituto Castro, nossos especialistas avaliam suas necessidades. Estamos na Av. Paes de Barros, 1378. Gostaria de agendar?",
  ]);
  for (const p of partes) assert(p.length <= MAX_CARACTERES_BLOCO, p);
  // Curto ou com quebra de linha (lista, endereco com link) fica como esta.
  assertEquals(partesDaResposta("Que bom!"), ["Que bom!"]);
  const comLinhas = "📍 Estamos na Av. Paes de Barros, 1378 — Mooca, São Paulo.\nPara facilitar sua chegada, acesse nossa localização:\nhttps://maps.app.goo.gl/wWJYrgfSpF1gA6Tq6 e venha nos visitar quando puder, será um prazer.";
  assertEquals(partesDaResposta(comLinhas), [comLinhas]);
});

Deno.test("abertura: texto institucional do Instituto", () => {
  const sp = montarSystemPrompt({ primeiroNome: "Ana", funil: null, etapa: null, exemplos: [], agoraLocal: "x" });
  assertStringIncludes(sp, "Olá, Ana! Sou a Jully, consultora do Instituto Castro. Seja bem-vindo(a)!");
  assertStringIncludes(sp, "O que motivou seu contato: cuidar da saúde, buscar o emagrecimento ou ambos?");
  assertStringIncludes(sp, "Central Nacional Unimed (CNU)");
  assert(!sp.includes("Sem emoji"));
});
