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

// Le "HH:MM", "15h", "15h30", "15:30" ou "15". Devolve minutos do dia ou null.
export function interpretarHorario(texto: string): number | null {
  const s = normalizar(texto).replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:(?::|h)(\d{2})?)?(?:h|hs|hrs|horas)?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0;
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Ultimo inicio de avaliacao (30 min) no dia: seg-qui ate 18:30, sex ate 17:30.
function ultimoInicio(diaSemana: number): number {
  return diaSemana === 5 ? 17 * 60 + 30 : 18 * 60 + 30;
}

// Proximo slot de avaliacao (30 min, horario de Sao Paulo) no dia pedido.
// Com horarioPreferido valido ("15:00", "15h") usa esse horario, arredondado
// para baixo na meia hora (15:10 -> 15:00); fora do expediente (antes das 08:00
// ou depois do ultimo inicio do dia) ele e ignorado. Sem horario: manha 09:00,
// tarde 14:00. Se o dia cair em fim de semana, ou se o slot ja passou, avanca
// para o proximo dia util. Devolve inicio/fim em UTC (Date).
export function proximoSlot(
  diaPreferido: string,
  periodo: Periodo,
  agoraUTC: Date = new Date(),
  tz: string = TZ_PADRAO,
  horarioPreferido: string = "",
): { inicio: Date; fim: Date } {
  const padrao = periodo === "tarde" ? 14 * 60 : 9 * 60;
  const pedido = interpretarHorario(horarioPreferido);
  let d = interpretarDia(diaPreferido, agoraUTC, tz);
  for (let i = 0; i < 14; i++) {
    const diaSemana = partesNoFuso(dataLocal(d.ano, d.mes, d.dia, 12, 0, tz), tz).diaSemana;
    let min = padrao;
    if (pedido != null) {
      const arred = pedido - (pedido % 30);
      if (arred >= 8 * 60 && arred <= ultimoInicio(diaSemana)) min = arred;
    }
    const inicio = dataLocal(d.ano, d.mes, d.dia, Math.floor(min / 60), min % 60, tz);
    const util = diaSemana >= 1 && diaSemana <= 5;
    if (util && inicio.getTime() > agoraUTC.getTime()) {
      return { inicio, fim: new Date(inicio.getTime() + 30 * 60000) };
    }
    d = somarDias(d.ano, d.mes, d.dia, 1);
  }
  // Nunca deve chegar aqui (14 dias cobrem qualquer fim de semana); garante retorno.
  const inicio = dataLocal(d.ano, d.mes, d.dia, Math.floor(padrao / 60), padrao % 60, tz);
  return { inicio, fim: new Date(inicio.getTime() + 30 * 60000) };
}

// Conflito de agenda: [inicio, fim) de um slot ja tem `vagas` agendamentos
// cruzando? (vagas = quantas consultas cabem no mesmo horario; padrao 1.)
export function slotOcupado(inicio: Date, fim: Date, ocupados: ReadonlyArray<{ inicio: string; fim: string }>, vagas = 1): boolean {
  const a = inicio.getTime(), b = fim.getTime();
  const cruzam = ocupados.filter((o) => {
    const oi = Date.parse(o.inicio), of = Date.parse(o.fim);
    return Number.isFinite(oi) && Number.isFinite(of) && oi < b && of > a;
  }).length;
  return cruzam >= Math.max(1, vagas);
}

// Proximos slots de 30 min livres a partir de um instante, no expediente
// (seg-qui 08:00-18:30, sex 08:00-17:30, ultimo inicio), pulando os ocupados.
// Usado para sugerir outro horario quando o pedido ja esta tomado.
export function proximosSlotsLivres(
  depoisDe: Date,
  ocupados: ReadonlyArray<{ inicio: string; fim: string }>,
  qtd = 2,
  agoraUTC: Date = new Date(),
  tz: string = TZ_PADRAO,
  vagas = 1,
): Date[] {
  const out: Date[] = [];
  const minimo = Math.max(depoisDe.getTime(), agoraUTC.getTime() + 60 * 60000); // nunca daqui a menos de 1 h
  const p = partesNoFuso(new Date(minimo), tz);
  let d = { ano: p.ano, mes: p.mes, dia: p.dia };
  for (let i = 0; i < 21 && out.length < qtd; i++) {
    const diaSemana = partesNoFuso(dataLocal(d.ano, d.mes, d.dia, 12, 0, tz), tz).diaSemana;
    if (diaSemana >= 1 && diaSemana <= 5) {
      for (let min = 8 * 60; min <= ultimoInicio(diaSemana) && out.length < qtd; min += 30) {
        const inicio = dataLocal(d.ano, d.mes, d.dia, Math.floor(min / 60), min % 60, tz);
        if (inicio.getTime() < minimo) continue;
        const fim = new Date(inicio.getTime() + 30 * 60000);
        if (!slotOcupado(inicio, fim, ocupados, vagas)) out.push(inicio);
      }
    }
    d = somarDias(d.ano, d.mes, d.dia, 1);
  }
  return out;
}
