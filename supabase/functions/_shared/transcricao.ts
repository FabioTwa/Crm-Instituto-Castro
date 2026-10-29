// Transcricao de audio (Groq Whisper) com status por audio.
//
// Cada audio em crm_conversas guarda (SQL 46):
//   transcricao_status      pendente | ok | falhou | ignorado
//   transcricao_erro        motivo CURTO, um codigo fixo daqui (nunca texto do
//                           audio, telefone, nome ou resposta crua da Groq)
//   transcricao_tentativas  quantas vezes a Groq foi chamada
//   transcrita_em           hora em que a transcricao deu certo
//
// Regra do 429 (limite da Groq): conta como tentativa, NAO como falha final.
// O webhook tenta de novo na hora (com espera curta) e, se o limite continuar,
// o audio fica 'pendente' para o varredor tentar mais tarde. So vira 'falhou'
// quando passa de MAX_TENTATIVAS. Qualquer outro erro e falha final.
//
// Chave via secret GROQ_API_KEY (compartilhada; este codigo so le).

export type StatusTranscricao = "pendente" | "ok" | "falhou" | "ignorado";

// Codigos de motivo. Fixos de proposito: o que vai para o banco e para o
// alerta nunca carrega dado pessoal.
export const MOTIVO = {
  flagDesligada: "flag_desligada",
  semChave: "sem_chave_groq",
  semMidia: "sem_midia",
  downloadFalhou: "download_falhou",
  limiteGroq: "groq_429",
  limiteEsgotado: "groq_429_esgotado",
  respostaVazia: "groq_resposta_vazia",
  excecao: "groq_excecao",
} as const;

export function motivoHttp(status: number): string {
  return `groq_http_${Math.trunc(Number(status) || 0)}`;
}

export const MAX_TENTATIVAS = 6; // total, somando webhook e varredor
export const TENTATIVAS_NA_HORA = 3; // dentro do webhook, antes de deixar pendente
const ESPERA_MAX_MS = 8000;

export type ResultadoTranscricao = {
  status: StatusTranscricao;
  texto: string | null;
  erro: string | null;
  tentativas: number; // total acumulado (anteriores + desta rodada)
  transcritaEm: string | null;
};

// Uma chamada a Groq. Devolve o texto, ou o codigo do erro e se foi limite.
type UmaChamada = { texto: string | null; erro: string | null; limite: boolean; esperaMs: number };

async function chamarGroq(key: string, bytes: ArrayBuffer, mimeType: string, fetchFn: typeof fetch): Promise<UmaChamada> {
  try {
    // WhatsApp entrega ogg/opus; o Whisper do Groq aceita direto.
    const tipo = mimeType && mimeType.includes("/") ? mimeType.split(";")[0] : "audio/ogg";
    const ext = tipo.includes("mp4") ? "mp4" : tipo.includes("mpeg") ? "mp3" : "ogg";
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: tipo }), `audio.${ext}`);
    fd.append("model", "whisper-large-v3");
    fd.append("language", "pt");
    fd.append("response_format", "json");
    const gr = await fetchFn("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (gr.status === 429) {
      await gr.body?.cancel();
      const ra = Number(gr.headers.get("retry-after") || "");
      return { texto: null, erro: MOTIVO.limiteGroq, limite: true, esperaMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0 };
    }
    if (!gr.ok) {
      // So o status vai para o log: a resposta da Groq nao e gravada.
      await gr.body?.cancel();
      console.error("[transcrever] Groq falhou:", gr.status);
      return { texto: null, erro: motivoHttp(gr.status), limite: false, esperaMs: 0 };
    }
    const jr: any = await gr.json();
    const txt = jr && (jr.text || jr.transcription) ? String(jr.text || jr.transcription).trim() : "";
    return txt
      ? { texto: txt, erro: null, limite: false, esperaMs: 0 }
      : { texto: null, erro: MOTIVO.respostaVazia, limite: false, esperaMs: 0 };
  } catch (e) {
    console.error("[transcrever] excecao:", e instanceof Error ? e.name : "erro");
    return { texto: null, erro: MOTIVO.excecao, limite: false, esperaMs: 0 };
  }
}

// Espera entre tentativas por 429: respeita o Retry-After da Groq, com teto,
// senao 2 s, 4 s...
export function esperaAposLimite(tentativaNestaRodada: number, retryAfterMs: number): number {
  const base = retryAfterMs > 0 ? retryAfterMs : 2000 * Math.pow(2, Math.max(0, tentativaNestaRodada - 1));
  return Math.min(base, ESPERA_MAX_MS);
}

// Transcreve com as regras acima. tentativasAnteriores vem do banco quando e o
// varredor tentando de novo (0 no webhook). maxNestaRodada limita quantas
// chamadas esta rodada pode fazer.
export async function transcreverComStatus(args: {
  bytes: ArrayBuffer;
  mimeType: string;
  tentativasAnteriores?: number;
  maxNestaRodada?: number;
  fetchFn?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
  agora?: () => Date;
}): Promise<ResultadoTranscricao> {
  const anteriores = Math.max(0, Math.trunc(args.tentativasAnteriores || 0));
  const fetchFn = args.fetchFn || fetch;
  const dormir = args.dormir || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agora = args.agora || (() => new Date());
  const key = Deno.env.get("GROQ_API_KEY") || "";
  if (!key) {
    console.warn("[transcrever] GROQ_API_KEY ausente; audio gravado sem transcricao");
    return { status: "falhou", texto: null, erro: MOTIVO.semChave, tentativas: anteriores, transcritaEm: null };
  }
  if (!args.bytes || args.bytes.byteLength === 0) {
    return { status: "falhou", texto: null, erro: MOTIVO.downloadFalhou, tentativas: anteriores, transcritaEm: null };
  }
  const limiteRodada = Math.max(1, Math.min(args.maxNestaRodada || TENTATIVAS_NA_HORA, MAX_TENTATIVAS - anteriores));
  let tentativas = anteriores;
  for (let i = 1; i <= limiteRodada; i++) {
    tentativas++;
    const r = await chamarGroq(key, args.bytes, args.mimeType, fetchFn);
    if (r.texto) return { status: "ok", texto: r.texto, erro: null, tentativas, transcritaEm: agora().toISOString() };
    if (!r.limite) return { status: "falhou", texto: null, erro: r.erro, tentativas, transcritaEm: null };
    if (tentativas >= MAX_TENTATIVAS) {
      return { status: "falhou", texto: null, erro: MOTIVO.limiteEsgotado, tentativas, transcritaEm: null };
    }
    if (i < limiteRodada) await dormir(esperaAposLimite(i, r.esperaMs));
  }
  // Ainda no limite da Groq, mas com tentativas sobrando: o varredor continua.
  return { status: "pendente", texto: null, erro: MOTIVO.limiteGroq, tentativas, transcritaEm: null };
}

// Campos para gravar em crm_conversas.
export function camposTranscricao(r: ResultadoTranscricao): Record<string, unknown> {
  return {
    transcricao_status: r.status,
    transcricao_erro: r.erro,
    transcricao_tentativas: r.tentativas,
    transcrita_em: r.transcritaEm,
  };
}

export function resultadoSemChamada(status: StatusTranscricao, erro: string, tentativas = 0): ResultadoTranscricao {
  return { status, texto: null, erro, tentativas, transcritaEm: null };
}
