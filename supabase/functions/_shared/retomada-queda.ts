// Retomada depois de uma queda do WhatsApp (Z-API, SQL 41).
//
// Enquanto o numero esta desconectado, as mensagens recebidas NAO chegam ao
// CRM e a Z-API nao as reenvia depois (teste de 28/10/2026). A lista de
// conversas da Z-API (_shared/zapi.ts chatsZapi) mostra QUEM falou e QUANDO,
// sem o texto. Com isso a Jully retoma essas pessoas uma por vez, com calma,
// pedindo com naturalidade que mandem de novo.
//
//   crm_ia_config:
//   retomada_queda_ligada         'false' desliga (padrao ligado)
//   retomada_queda_intervalo_min  minutos entre uma retomada e outra (1 a 60, padrao 3)
//   retomada_queda_horario        janela local "HH:MM-HH:MM" (padrao 08:00-20:00, nunca domingo)
//   retomada_queda_desconhecidos  'false' = so retoma quem ja tem card no CRM
//
// Logica pura (sem banco) para ser testavel.

import { canonicoTelefone, telefoneBrPlausivel } from "./telefone.ts";
import type { ChatZapi } from "./zapi.ts";

export const ETAPA_RETOMADA_QUEDA = "retomada_queda";
// Folga antes do momento em que a queda foi percebida (o varredor roda 1x por minuto).
export const FOLGA_DESCONEXAO_MS = 60_000;
// Margem para casar o horario da Z-API com o do CRM (relogios e atraso do webhook).
export const MARGEM_CASAMENTO_MS = 90_000;
// Depois disso a retomada perde o sentido e a pessoa fica de fora.
export const VALIDADE_RETOMADA_MS = 48 * 3600 * 1000;
// Quanto tempo depois de reconectar ainda tenta ler a lista de conversas.
export const PRAZO_COLETA_MS = 15 * 60_000;

export type ConfigRetomadaQueda = { ligada: boolean; intervaloMin: number; horario: string; desconhecidos: boolean };

export function configRetomadaQueda(cfg: Record<string, string>): ConfigRetomadaQueda {
  const n = Math.floor(Number(cfg.retomada_queda_intervalo_min ?? "3"));
  return {
    ligada: String(cfg.retomada_queda_ligada ?? "true").trim().toLowerCase() !== "false",
    intervaloMin: Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : 3,
    horario: String(cfg.retomada_queda_horario || "08:00-20:00").trim(),
    desconhecidos: String(cfg.retomada_queda_desconhecidos ?? "true").trim().toLowerCase() !== "false",
  };
}

export type ChatDaQueda = { telefone: string; nome: string; ultimaEm: number };

// Conversas com mensagem durante a queda: so contatos individuais com telefone
// brasileiro, fora os numeros ignorados (o proprio numero, os da equipe).
// Uma por telefone, da mais antiga para a mais nova (atende na ordem de chegada).
export function selecionarChatsDaQueda(
  chats: ReadonlyArray<ChatZapi>,
  a: { desconectadoEm: number; ate: number; ignorar: ReadonlyArray<string> },
): ChatDaQueda[] {
  const ignorar = new Set(a.ignorar.map((t) => canonicoTelefone(t)).filter(Boolean));
  const porTelefone = new Map<string, ChatDaQueda>();
  for (const c of chats) {
    if (c.grupo || c.ultimaEm == null || c.telefone.includes("@")) continue;
    if (c.ultimaEm < a.desconectadoEm || c.ultimaEm > a.ate) continue;
    const tel = canonicoTelefone(c.telefone);
    if (!telefoneBrPlausivel(tel) || ignorar.has(tel)) continue;
    const ja = porTelefone.get(tel);
    if (!ja || c.ultimaEm > ja.ultimaEm) porTelefone.set(tel, { telefone: tel, nome: c.nome, ultimaEm: c.ultimaEm });
  }
  return [...porTelefone.values()].sort((x, y) => x.ultimaEm - y.ultimaEm);
}

// A ultima mensagem da conversa ja esta no CRM (chegou antes da queda, depois
// dela, ou foi a equipe/IA que falou por ultimo): nao ha o que retomar.
export function jaNoCrm(ultimaNoCrmMs: number | null, ultimaNoChatMs: number): boolean {
  return ultimaNoCrmMs != null && ultimaNoCrmMs >= ultimaNoChatMs - MARGEM_CASAMENTO_MS;
}

// Uma retomada por vez: espera o intervalo desde a ultima que saiu.
export function podeRetomarAgora(ultimaProcessadaMs: number | null, agoraMs: number, intervaloMin: number): boolean {
  return ultimaProcessadaMs == null || agoraMs - ultimaProcessadaMs >= intervaloMin * 60_000;
}

export function retomadaVencida(ultimaMsgMs: number, agoraMs: number): boolean {
  return agoraMs - ultimaMsgMs > VALIDADE_RETOMADA_MS;
}

// Instrucao interna que vai como ultima fala para a IA escrever a retomada.
export function instrucaoRetomadaQueda(minutosDesde: number): string {
  const tempo = minutosDesde >= 120 ? `cerca de ${Math.round(minutosDesde / 60)} horas` : `cerca de ${Math.max(1, Math.round(minutosDesde))} minutos`;
  return (
    `[Aviso interno do sistema, não é mensagem da pessoa: o WhatsApp da clínica ficou fora do ar por um tempo e ` +
    `a pessoa mandou mensagem nesse período (há ${tempo}). O texto dessa mensagem NÃO chegou para você e você não sabe o que ela disse. ` +
    `Escreva UMA mensagem curta (1 ou 2 frases), natural, como uma pessoa escreveria: peça desculpas pela demora, ` +
    `diga que teve uma instabilidade no WhatsApp e que a última mensagem dela não chegou, e peça com gentileza para ela mandar de novo. ` +
    `Se a conversa acima tiver um assunto em aberto, pode citá-lo de leve, sem inventar nada do que ela possa ter escrito. ` +
    `Não se apresente de novo se já conversaram, não use emoji e não use ferramentas.]`
  );
}

// Se a IA falhar ou a pos-validacao barrar, vai um destes (sem emoji).
export const TEXTOS_RETOMADA_QUEDA: readonly string[] = [
  "Oi, tudo bem? Desculpa a demora. Tive uma instabilidade aqui no WhatsApp e a sua última mensagem não chegou pra mim. Consegue me mandar de novo?",
  "Oi! Me desculpa a demora, o WhatsApp ficou instável por aqui e acabei não recebendo a sua mensagem. Pode me mandar de novo, por favor?",
];

// Para quem ainda nao tem card: nao sabemos nada da pessoa, so que ela chamou.
export const TEXTOS_RETOMADA_QUEDA_NOVO: readonly string[] = [
  "Oi, tudo bem? Vi que você me chamou, mas tive uma instabilidade aqui no WhatsApp e a sua mensagem não chegou pra mim. Pode me mandar de novo?",
  "Oi! Vi que você mandou mensagem, mas o WhatsApp ficou instável por aqui e ela não chegou pra mim. Consegue me mandar de novo, por favor?",
];

export function textoRetomadaQuedaFixo(temCard: boolean, aleatorio: () => number = Math.random): string {
  const lista = temCard ? TEXTOS_RETOMADA_QUEDA : TEXTOS_RETOMADA_QUEDA_NOVO;
  return lista[Math.min(lista.length - 1, Math.floor(aleatorio() * lista.length))];
}
