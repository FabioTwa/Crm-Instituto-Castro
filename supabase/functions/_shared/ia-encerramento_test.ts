import { assertEquals } from "jsr:@std/assert";
import { decidirEncerramento, jaEncerrada, mensagensDaConversaAtual, minutosEncerramento } from "./ia-encerramento.ts";

const agora = new Date("2026-10-15T17:00:00Z");
const ha = (min: number) => new Date(agora.getTime() - min * 60000).toISOString();
const base = { agora, minutos: 60, ultimoEncerramentoEm: null, handoffPendente: false, dentroDoHorario: true };

Deno.test("minutosEncerramento: padrao, desligado e limites", () => {
  assertEquals(minutosEncerramento({}), 60);
  assertEquals(minutosEncerramento({ encerrar_apos_minutos: "30" }), 30);
  assertEquals(minutosEncerramento({ encerrar_apos_minutos: "0" }), 0);
  assertEquals(minutosEncerramento({ encerrar_apos_minutos: "2" }), 5);
  assertEquals(minutosEncerramento({ encerrar_apos_minutos: "9999" }), 1440);
  assertEquals(minutosEncerramento({ encerrar_apos_minutos: "abc" }), 60);
});

Deno.test("encerra quando a IA falou por ultimo e o prazo passou", () => {
  assertEquals(decidirEncerramento({ ...base, ultima: { autor: "ia", criada_em: ha(61) } }), "enviar");
  assertEquals(decidirEncerramento({ ...base, ultima: { autor: "ia", criada_em: ha(59) } }), null);
});

Deno.test("nao encerra se o lead ou o vendedor falou por ultimo, ou com handoff pendente", () => {
  assertEquals(decidirEncerramento({ ...base, ultima: { autor: "lead", criada_em: ha(120) } }), null);
  assertEquals(decidirEncerramento({ ...base, ultima: { autor: "vendedor", criada_em: ha(120) } }), null);
  assertEquals(decidirEncerramento({ ...base, handoffPendente: true, ultima: { autor: "ia", criada_em: ha(120) } }), null);
});

Deno.test("nao encerra duas vezes", () => {
  const ultima = { autor: "ia", criada_em: ha(120) };
  assertEquals(decidirEncerramento({ ...base, ultima: { ...ultima, payload_raw: { encerramento: true } } }), null);
  assertEquals(decidirEncerramento({ ...base, ultima, ultimoEncerramentoEm: ha(30) }), null);
  // Encerramento antigo (antes da ultima mensagem da IA) nao conta.
  assertEquals(decidirEncerramento({ ...base, ultima, ultimoEncerramentoEm: ha(300) }), "enviar");
});

Deno.test("fora do horario ou depois de 24 h encerra sem mensagem", () => {
  assertEquals(decidirEncerramento({ ...base, dentroDoHorario: false, ultima: { autor: "ia", criada_em: ha(90) } }), "sem_mensagem");
  assertEquals(decidirEncerramento({ ...base, ultima: { autor: "ia", criada_em: ha(25 * 60) } }), "sem_mensagem");
});

Deno.test("desligado (0) nunca encerra", () => {
  assertEquals(decidirEncerramento({ ...base, minutos: 0, ultima: { autor: "ia", criada_em: ha(600) } }), null);
});

Deno.test("mensagensDaConversaAtual: descarta o que veio antes do encerramento", () => {
  const msgs = [
    { autor: "lead", criada_em: "2026-10-16T17:00:00Z" },
    { autor: "ia", criada_em: "2026-10-16T17:01:00Z" },
    { autor: "lead", criada_em: "2026-10-16T18:15:00Z" },
  ];
  assertEquals(mensagensDaConversaAtual(msgs, "2026-10-16T17:50:00Z").map((m) => m.criada_em), ["2026-10-16T18:15:00Z"]);
  assertEquals(mensagensDaConversaAtual(msgs, null).length, 3);
  assertEquals(mensagensDaConversaAtual(msgs, "lixo").length, 3);
});

Deno.test("jaEncerrada: clique duplo nao encerra de novo; mensagem nova do lead reabre", () => {
  assertEquals(jaEncerrada(null, "2026-10-29T12:00:00Z"), false);
  assertEquals(jaEncerrada(null, null), false);
  assertEquals(jaEncerrada("2026-10-29T12:05:00Z", "2026-10-29T12:00:00Z"), true);
  assertEquals(jaEncerrada("2026-10-29T12:05:00Z", null), true);
  assertEquals(jaEncerrada("2026-10-29T12:05:00Z", "2026-10-29T12:06:00Z"), false);
});
