// Regras puras da importacao do Support Clinic (ic-supportclinic). Sem rede e
// sem banco, para poder testar.

export type LinhaSC = {
  codigo: string;
  telefone: string;
  data: string;
  tipo: string;
  profissional: string;
  agendado_por: string;
  status: string;
  criado: string;
};

export const MAX_LINHAS = 20000;

const LIMITES: Record<keyof LinhaSC, number> = {
  codigo: 40,
  telefone: 40,
  data: 40,
  tipo: 200,
  profissional: 120,
  agendado_por: 120,
  status: 40,
  criado: 40,
};

function texto(v: unknown, max: number): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim().slice(0, max);
}

function dataISO(v: unknown): string | null {
  const s = String(v || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) ? s : null;
}

// Valida o corpo de {acao:'importar'}. So os campos conhecidos passam; o nome do
// paciente, se vier, e descartado aqui.
export function validarImportacao(body: any):
  | { ok: true; ini: string; fim: string; linhas: LinhaSC[] }
  | { ok: false; erro: string } {
  if (!body || typeof body !== "object") return { ok: false, erro: "payload_invalido" };
  const ini = dataISO(body.periodo && body.periodo.ini);
  const fim = dataISO(body.periodo && body.periodo.fim);
  if (!ini || !fim || fim < ini) return { ok: false, erro: "periodo_invalido" };
  const dias = (Date.parse(fim) - Date.parse(ini)) / 86400000;
  if (dias > 100) return { ok: false, erro: "periodo_invalido" };
  if (!Array.isArray(body.linhas)) return { ok: false, erro: "linhas_invalidas" };
  if (body.linhas.length > MAX_LINHAS) return { ok: false, erro: "linhas_demais" };
  const linhas: LinhaSC[] = [];
  for (const l of body.linhas) {
    if (!l || typeof l !== "object") continue;
    const out = {} as LinhaSC;
    for (const k of Object.keys(LIMITES) as (keyof LinhaSC)[]) out[k] = texto((l as any)[k], LIMITES[k]);
    if (!out.codigo || !out.status) continue;
    linhas.push(out);
  }
  return { ok: true, ini, fim, linhas };
}

// Etapas do robo que podem falhar (o texto vai no aviso ao Fabio).
const ETAPAS: Record<string, string> = {
  login: "entrar no Support Clinic",
  relatorio: "abrir o relatório de agendamentos",
  periodo: "preencher o período",
  exportar: "baixar o Excel",
  planilha: "ler o Excel",
  envio: "enviar ao CRM",
  importacao: "gravar no CRM",
  robo: "rodar o robô",
};

// Mensagem de WhatsApp quando o robo falha. Sem dado de paciente; o motivo vem
// do robo, que so manda textos fixos dele (cortado aqui por seguranca).
export function textoAlertaFalha(etapa: unknown, motivo: unknown, quando: Date): string {
  const e = ETAPAS[String(etapa || "")] || ETAPAS.robo;
  const m = texto(motivo, 300) || "motivo não informado";
  const hora = quando.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return [
    "⚠️ Robô do Support Clinic",
    `A exportação de hoje (${hora}) não foi concluída.`,
    `Etapa: ${e}.`,
    `Motivo: ${m}`,
    "Nada foi alterado no Support Clinic. O robô não tenta de novo hoje; amanhã ele roda no horário sorteado.",
  ].join("\n");
}
