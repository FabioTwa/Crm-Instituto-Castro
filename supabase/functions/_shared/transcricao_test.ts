import { assertEquals } from "jsr:@std/assert@1";
import { esperaAposLimite, MAX_TENTATIVAS, MOTIVO, transcreverComStatus } from "./transcricao.ts";

const bytes = new Uint8Array([1, 2, 3]).buffer;
const agora = () => new Date("2026-10-29T18:00:00.000Z");
const semEspera = () => Promise.resolve();

// fetch falso: devolve as respostas na ordem e conta as chamadas.
function fetchFalso(respostas: Array<() => Response>) {
  let n = 0;
  const f = (() => {
    const r = respostas[Math.min(n, respostas.length - 1)]();
    n++;
    return Promise.resolve(r);
  }) as unknown as typeof fetch;
  return { f, chamadas: () => n };
}
const ok = (txt: string) => () => new Response(JSON.stringify({ text: txt }), { status: 200 });
const limite = () => new Response("rate limit", { status: 429 });
const erro500 = () => new Response("boom", { status: 500 });

function comChave(fn: () => Promise<void>) {
  return async () => {
    const antes = Deno.env.get("GROQ_API_KEY");
    Deno.env.set("GROQ_API_KEY", "teste");
    try {
      await fn();
    } finally {
      if (antes === undefined) Deno.env.delete("GROQ_API_KEY");
      else Deno.env.set("GROQ_API_KEY", antes);
    }
  };
}

Deno.test("sucesso de primeira: ok, 1 tentativa, hora gravada", comChave(async () => {
  const { f } = fetchFalso([ok("ola")]);
  const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
  assertEquals(r, { status: "ok", texto: "ola", erro: null, tentativas: 1, transcritaEm: "2026-10-29T18:00:00.000Z" });
}));

Deno.test("429 e depois sucesso: conta as tentativas e fica ok", comChave(async () => {
  const { f, chamadas } = fetchFalso([limite, limite, ok("certo")]);
  const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
  assertEquals(r.status, "ok");
  assertEquals(r.tentativas, 3);
  assertEquals(chamadas(), 3);
}));

Deno.test("429 o tempo todo no webhook: pendente, nao falha final", comChave(async () => {
  const { f } = fetchFalso([limite]);
  const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
  assertEquals(r, { status: "pendente", texto: null, erro: MOTIVO.limiteGroq, tentativas: 3, transcritaEm: null });
}));

Deno.test("429 na ultima tentativa permitida: falhou por limite esgotado", comChave(async () => {
  const { f } = fetchFalso([limite]);
  const r = await transcreverComStatus({
    bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora,
    tentativasAnteriores: MAX_TENTATIVAS - 1, maxNestaRodada: 1,
  });
  assertEquals(r, { status: "falhou", texto: null, erro: MOTIVO.limiteEsgotado, tentativas: MAX_TENTATIVAS, transcritaEm: null });
}));

Deno.test("varredor: uma chamada por rodada, soma as anteriores", comChave(async () => {
  const { f, chamadas } = fetchFalso([limite]);
  const r = await transcreverComStatus({
    bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora, tentativasAnteriores: 3, maxNestaRodada: 1,
  });
  assertEquals(r.status, "pendente");
  assertEquals(r.tentativas, 4);
  assertEquals(chamadas(), 1);
}));

Deno.test("erro que nao e 429: falha final com codigo curto, sem nova tentativa", comChave(async () => {
  const { f, chamadas } = fetchFalso([erro500, ok("nunca")]);
  const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
  assertEquals(r, { status: "falhou", texto: null, erro: "groq_http_500", tentativas: 1, transcritaEm: null });
  assertEquals(chamadas(), 1);
}));

Deno.test("resposta vazia da Groq: falhou", comChave(async () => {
  const { f } = fetchFalso([ok("   ")]);
  const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
  assertEquals(r.status, "falhou");
  assertEquals(r.erro, MOTIVO.respostaVazia);
}));

Deno.test("excecao de rede: falhou com codigo, sem detalhe", comChave(async () => {
  const f = (() => Promise.reject(new Error("dns 11999999999"))) as unknown as typeof fetch;
  const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
  assertEquals(r.erro, MOTIVO.excecao);
}));

Deno.test("sem chave: falhou sem chamar a Groq", async () => {
  const antes = Deno.env.get("GROQ_API_KEY");
  Deno.env.delete("GROQ_API_KEY");
  try {
    const { f, chamadas } = fetchFalso([ok("x")]);
    const r = await transcreverComStatus({ bytes, mimeType: "audio/ogg", fetchFn: f, dormir: semEspera, agora });
    assertEquals(r, { status: "falhou", texto: null, erro: MOTIVO.semChave, tentativas: 0, transcritaEm: null });
    assertEquals(chamadas(), 0);
  } finally {
    if (antes !== undefined) Deno.env.set("GROQ_API_KEY", antes);
  }
});

Deno.test("espera entre 429: Retry-After com teto, senao 2 s e 4 s", () => {
  assertEquals(esperaAposLimite(1, 0), 2000);
  assertEquals(esperaAposLimite(2, 0), 4000);
  assertEquals(esperaAposLimite(1, 3000), 3000);
  assertEquals(esperaAposLimite(1, 60000), 8000);
});
