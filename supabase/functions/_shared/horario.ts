// Horario comercial e slots de agendamento, sempre no fuso America/Sao_Paulo.
// Logica pura (sem banco) para ser testavel.
//
// Regras da clinica (Instituto Castro, Mooca/SP): seg-qui 08h-19h, sex 08h-18h,
// fechado sabado e domingo.

export const TZ_PADRAO = "America/Sao_Paulo";

type Partes = { ano: number; mes: number; dia: number; hora: number; minuto: number; diaSemana: number };

// Componentes locais de um instante UTC no fuso pedido. diaSemana: 0=dom ... 6=sab.
export function partesNoFuso(d: Date, tz: string = TZ_PADRAO): Partes {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  const semana: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    diaSemana: semana[p.weekday] ?? 0,
  };
}

// Deslocamento (minutos) do fuso em relacao ao UTC naquele instante.
function offsetMinutos(d: Date, tz: string): number {
  const p = partesNoFuso(d, tz);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, 0, 0);
  const base = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), 0, 0,
  );
  return Math.round((comoUtc - base) / 60000);
}

// Constroi o instante UTC correspondente a uma data/hora LOCAL no fuso.
export function dataLocal(ano: number, mes: number, dia: number, hora: number, minuto: number, tz: string = TZ_PADRAO): Date {
  const palpite = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto, 0, 0));
  const off1 = offsetMinutos(palpite, tz);
  let r = new Date(palpite.getTime() - off1 * 60000);
  const off2 = offsetMinutos(r, tz);
  if (off2 !== off1) r = new Date(palpite.getTime() - off2 * 60000);
  return r;
}

function hhmmParaMinutos(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Dentro do horario de atendimento da IA? inicio/fim em "HH:MM" (ex.: "08:00",
// "19:00"), interpretados no fuso. Fim de semana e sempre fora. Sexta termina
// no minimo as 18:00 mesmo que o fim configurado seja mais tarde.
export function dentroDoHorario(agoraUTC: Date, inicio: string, fim: string, tz: string = TZ_PADRAO): boolean {
  const ini = hhmmParaMinutos(inicio);
  let fimMin = hhmmParaMinutos(fim);
  if (ini == null || fimMin == null) return false;
  const p = partesNoFuso(agoraUTC, tz);
  if (p.diaSemana === 0 || p.diaSemana === 6) return false;
  if (p.diaSemana === 5) fimMin = Math.min(fimMin, 18 * 60);
  const agora = p.hora * 60 + p.minuto;
  return agora >= ini && agora < fimMin;
}

export type Periodo = "manha" | "tarde";

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, segunda: 1, "segunda-feira": 1, terca: 2, "terca-feira": 2, quarta: 3, "quarta-feira": 3,
  quinta: 4, "quinta-feira": 4, sexta: 5, "sexta-feira": 5, sabado: 6,
};

function normalizar(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function somarDias(ano: number, mes: number, dia: number, n: number): { ano: number; mes: number; dia: number } {
  const d = new Date(Date.UTC(ano, mes - 1, dia + n));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

// Interpreta o dia preferido: "YYYY-MM-DD", "DD/MM", "DD/MM/YYYY", "hoje",
// "amanha", "depois de amanha", nome do dia da semana ("segunda", "quinta-feira",
// "proxima terca"). Qualquer outra coisa (ou vazio) = o proximo dia util a partir de hoje.
export function interpretarDia(diaPreferido: string, agoraUTC: Date, tz: string = TZ_PADRAO): { ano: number; mes: number; dia: number } {
  const hoje = partesNoFuso(agoraUTC, tz);
  const base = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia };
  const s = normalizar(diaPreferido);
  if (!s) return base;

  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) {
    let ano = m[3] ? Number(m[3]) : hoje.ano;
    if (ano < 100) ano += 2000;
    const r = { ano, mes: Number(m[2]), dia: Number(m[1]) };
    // "05/01" dito em dezembro quer dizer o ano que vem.
    if (!m[3] && (r.mes < hoje.mes || (r.mes === hoje.mes && r.dia < hoje.dia))) r.ano += 1;
    return r;
  }
  if (/^hoje$/.test(s)) return base;
  if (/^(amanha|amanhã)$/.test(s)) return somarDias(base.ano, base.mes, base.dia, 1);
  if (/^depois de amanha/.test(s)) return somarDias(base.ano, base.mes, base.dia, 2);

  const chave = s.replace(/^(proxima|proximo|essa|esta|nesta|na|no)\s+/, "").replace(/\s+feira$/, "-feira");
  const alvo = DIAS_SEMANA[chave] ?? DIAS_SEMANA[chave.replace(/-feira$/, "")];
  if (alvo != null) {
    let delta = (alvo - hoje.diaSemana + 7) % 7;
    if (delta === 0) delta = 7; // "quinta" dita numa quinta = a proxima
    return somarDias(base.ano, base.mes, base.dia, delta);
  }
  return base;
}

// Proximo slot de avaliacao: manha 09:00-09:30, tarde 14:00-14:30 (horario de
// Sao Paulo) do dia pedido. Se o dia cair em fim de semana, ou se o slot ja
// passou (ex.: pediu "hoje a tarde" as 17h, ou sexta depois das 18h), avanca
// para o proximo dia util. Devolve inicio/fim em UTC (Date).
export function proximoSlot(
  diaPreferido: string,
  periodo: Periodo,
  agoraUTC: Date = new Date(),
  tz: string = TZ_PADRAO,
): { inicio: Date; fim: Date } {
  const hora = periodo === "tarde" ? 14 : 9;
  let d = interpretarDia(diaPreferido, agoraUTC, tz);
  for (let i = 0; i < 14; i++) {
    const inicio = dataLocal(d.ano, d.mes, d.dia, hora, 0, tz);
    const diaSemana = partesNoFuso(inicio, tz).diaSemana;
    const util = diaSemana >= 1 && diaSemana <= 5;
    if (util && inicio.getTime() > agoraUTC.getTime()) {
      return { inicio, fim: new Date(inicio.getTime() + 30 * 60000) };
    }
    d = somarDias(d.ano, d.mes, d.dia, 1);
  }
  // Nunca deve chegar aqui (14 dias cobrem qualquer fim de semana); garante retorno.
  const inicio = dataLocal(d.ano, d.mes, d.dia, hora, 0, tz);
  return { inicio, fim: new Date(inicio.getTime() + 30 * 60000) };
}
