import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { contextoReclamacao, detectarReclamacao, textoAlertaReclamacao } from "./reclamacao.ts";

Deno.test("detectarReclamacao: falta de retorno (caso real de 24/11)", () => {
  const r = detectarReclamacao("Nossa já mandei mensagem neste número q vc mandou e ninguém responde desde ontem");
  assertEquals(r?.motivo, "sem_retorno");
  assertEquals(detectarReclamacao("Até agora nada, ninguém me ligou")?.motivo, "sem_retorno");
  assertEquals(detectarReclamacao("ainda estou esperando o retorno")?.motivo, "sem_retorno");
  assertEquals(detectarReclamacao("Vocês não me responderam")?.motivo, "sem_retorno");
});

Deno.test("detectarReclamacao: insatisfacao clara", () => {
  assertEquals(detectarReclamacao("Que absurdo esse atendimento")?.motivo, "insatisfacao");
  assertEquals(detectarReclamacao("Vou reclamar no Reclame Aqui")?.motivo, "insatisfacao");
  assertEquals(detectarReclamacao("isso é falta de respeito")?.motivo, "insatisfacao");
});

Deno.test("detectarReclamacao: mensagens comuns nao contam", () => {
  for (const t of [
    "Olá, vim através do anúncio e tenho interesse em fazer uma avaliação nutrológica",
    "Qto custa consulta ..preciso perder peso",
    "É pelo convênio né??",
    "Vão me responder pelo outro número?",
    "Não é reclamação, só uma dúvida",
    "Sim",
    "",
  ]) assertEquals(detectarReclamacao(t), null, t);
});

Deno.test("contextoReclamacao: so com o que esta no CRM", () => {
  const c = contextoReclamacao({ pedidoEm: "2026-11-23T18:41:00Z", agendamento: null, callcenter: "551120208098" });
  assertStringIncludes(c, "Em 23/11, às 15h41, eu passei o pedido de agendamento ao time");
  assertStringIncludes(c, "(11) 2020-8098");
  assertStringIncludes(c, "Até agora não há horário marcado no CRM.");
  const c2 = contextoReclamacao({ pedidoEm: null, agendamento: { inicio: "2026-11-24T17:00:00Z", status: "pendente" }, callcenter: null });
  assertEquals(c2, "No CRM, o horário está marcado para 24/11, às 14h (ainda sem confirmação).");
  assertStringIncludes(contextoReclamacao({ pedidoEm: null, agendamento: null, callcenter: null }), "não havia pedido");
});

Deno.test("textoAlertaReclamacao: grupo com apresentacao, dados e marcacoes; time sem marcacoes", () => {
  const base = {
    nome: "Priscila Borges", telefone: "5511964787504", mensagem: "ninguém responde desde ontem",
    motivo: "sem_retorno" as const, contexto: "Contexto.", recebidaEm: "2026-11-24T17:39:00Z", temPedido: true,
  };
  const g = textoAlertaReclamacao({ ...base, para: "grupo", marcar: ["5511954580790", "5511963201355"] });
  assert(g.startsWith("Olá, pessoal, tudo bem? 😊\nAqui é a Jully, a inteligência artificial"));
  assertStringIncludes(g, "*Paciente:* Priscila Borges");
  assertStringIncludes(g, "*Telefone:* (11) 96478-7504");
  assertStringIncludes(g, "*Motivo da reclamação:* falta de retorno do time de agendamento. Mensagem de 24/11, às 14h39:");
  assertStringIncludes(g, "*O que aconteceu:* Contexto.");
  assert(g.endsWith("@5511954580790 @5511963201355"));
  const t = textoAlertaReclamacao({ ...base, para: "time" });
  assert(t.startsWith("Olá, tudo bem? 😊"));
  assert(!t.includes("@55"));
});
