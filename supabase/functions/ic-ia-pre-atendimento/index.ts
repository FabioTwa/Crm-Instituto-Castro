// ic-ia-pre-atendimento: IA de pre-atendimento do Instituto Castro no WhatsApp.
//
// Quem chama: SOMENTE o ic-meta-webhook (segundo plano), com header
// x-ic-internal = IC_INTERNAL_SECRET, body {cliente_crm_id, conversa_id,
// vendedor_id, funil_id}. Nunca o front.
// O varredor do webhook (pg_cron) tambem chama, uma vez por minuto, com
// {acao:'encerrar_inativas'}: com followups_minutos preenchido (SQL 37, padrao)
// a IA RETOMA as conversas em que o lead parou de responder e nunca encerra
// (_shared/ia-followup.ts); com followups_minutos vazio volta o encerramento
// por inatividade (crm_ia_config.encerrar_apos_minutos; _shared/ia-encerramento.ts).
// Na mesma rodada: lembrete de confirmacao (SQL 39) e retomada de quem escreveu
// enquanto o WhatsApp estava desconectado (SQL 41, _shared/retomada-queda.ts).
//
// ATENDIMENTO ATE O AGENDAMENTO (SQL 37): a IA ("Julie", crm_ia_config.persona_*)
// responde a qualquer hora, informa valores, reserva o horario (ic-agendamento
// 'propor', status pendente, sem conflito na agenda) e avisa pelo WhatsApp quem
// confirma com o lead (aviso_agendamento_whatsapp). Depois de agendar, abre o
// handoff agendamento_confirmado (so historico), e a IA segue respondendo.
// ATENDIMENTO 100% AUTONOMO (22/10/2026): nao existe atendente. A IA nunca diz
// que vai passar para a equipe; so a recusa do consentimento (LGPD) a cala.
// Publicar: supabase functions deploy ic-ia-pre-atendimento --no-verify-jwt
//
// PIPELINE (cada etapa grava uma linha em ia_decisoes_log com etapa_pipeline e decisao):
//   1  flags            ic_flag('ia_pre_atendimento') e crm_ia_config.ligada='true'
//   2  humano_assumiu   vendedor respondeu nas ultimas 24 h (e depois do ultimo
//                       encerramento) -> fim; consentimento negado pendente -> fim
//   3  limites          horario (so com atender_fora_do_horario='false': 1 aviso/dia/card),
//                       max_respostas_por_conversa (atingiu: handoff 'manual'),
//                       contado desde o ultimo encerramento por inatividade
//   4  contexto         RPC ic_ia_contexto(card, contexto_mensagens=30), so mensagens depois do
//                       ultimo encerramento
//   5  consentimento    LGPD: pede, interpreta SIM/NAO, nega -> handoff + despedida
//   6  handoff_regras   regex por CODIGO: urgencia e duvida clinica -> texto fixo (CFM);
//                       reclamacao e pedido de humano -> so log, a IA conduz
//   7  exemplos         ate 20 ia_exemplos_conversa ativos, filtrados por tag do funil
//   8  claude           Messages API (fetch), tools propor_agendamento / cancelar_agendamento
//   9  pos_validacao    filtro regex CFM na resposta do modelo
//      (antes das tools: mensagem nova do lead durante a IA -> desiste, a nova responde)
//   10 tools            executa as ferramentas (ic-agendamento 'propor'/'cancelar' + aviso a equipe)
//   11 envio            provedor do numero (_shared/whatsapp-envio.ts: Meta ou Z-API) + crm_conversas autor 'ia'
//   12 funil            RPC ic_avancar_etapa (SQL 33): card anda so para frente
//                       (conversa -> em_conversa; lead pergunta valor/convenio/formato
//                       -> negociacao; IA propoe horario -> agendamento_pendente)
//
// FASE DE TESTE: crm_ia_config.numeros_teste preenchida = so esses telefones sao
// atendidos (os demais: decisao='fora_dos_numeros_teste'). Ver _shared/ia-teste.ts.
//
// MODO SOMBRA: se crm_ia_config.modo_sombra nao for 'false' (padrao 'true'),
// ou ic_flag('envio_whatsapp_cloud_api') for false, ou o numero do
// vendedor nao tiver provedor configurado, ou faltar a credencial dele, TUDO roda igual, mas nada e enviado: decisao='simulada_envio_desligado'
// e a resposta que teria saido fica em ia_decisoes_log.detalhe.resposta.
//
// LGPD / MINIMIZACAO: para a Anthropic vai so o system prompt (_shared/ia-prompt.ts),
// o primeiro nome, funil/etapa, o texto das ultimas 12 mensagens e os exemplos.
// Em ia_decisoes_log.dados_enviados_resumo entram apenas contagens e tipos.
//
// CFM 2.336/2023: regras no prompt E em codigo (handoff-regras antes da IA,
// pos-validacao depois). A IA reserva o horario (status pendente); quem confirma e a equipe.
//
// VARIAVEIS DE AMBIENTE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (o Supabase injeta)
//   IC_INTERNAL_SECRET            autoriza a chamada do webhook e as chamadas a ic-agendamento
//   ANTHROPIC_API_KEY             Messages API da Anthropic
//   META_ACCESS_TOKEN             envio pela Cloud API, provedor 'meta' (ausente = modo sombra)
//   ZAPI_INSTANCE_TOKEN, ZAPI_CLIENT_TOKEN  envio pela Z-API, provedor 'zapi' (ausente = modo sombra)
//   IC_POLITICA_PRIVACIDADE_URL   link no pedido de consentimento (opcional)
//
// OBSERVACAO SOBRE A API DA ANTHROPIC (conferido na skill claude-api em 03/10/2026):
//   - modelo padrao 'claude-sonnet-5-5' (configuravel em crm_ia_config.modelo);
//   - Sonnet 5.5 / Opus 5.5 REJEITAM temperature fora do padrao (400) e tool_choice
//     forcado; por isso NAO mandamos temperature (a especificacao pedia 0.4) e usamos
//     tool_choice auto com instrucao explicita no prompt;
//   - thinking adaptativo e ligado por padrao e CONSOME max_tokens; usamos
//     output_config.effort='low' e max_tokens configuravel (padrao 1024, nao 400)
//     para a resposta curta nunca ser cortada;
//   - stop_reason 'refusal' e 'max_tokens' sao tratados como erro_ia (resposta fixa).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, erroGenerico, json } from "../_shared/http.ts";
import { chamadaInternaValida, headersInternos, tokenDoHeader, usuarioAtivo } from "../_shared/auth.ts";
import { iaConfig, icFlag } from "../_shared/flags.ts";
import { canonicoTelefone, soDigitos, telefoneBrPlausivel, variacoesTelefone } from "../_shared/telefone.ts";
import { canalDaLinha, canalDoVendedor, type CanalEnvio, enviarTextoCanal, provedorDaLinha } from "../_shared/whatsapp-envio.ts";
import { type CanalZapi, type ChatZapi, chatsZapi, lerMensagemZapi, mensagensChatZapi, msLeitura, segundosDigitando, statusZapi } from "../_shared/zapi.ts";
import { detectarHandoff, handoffCalaIA, RESPOSTA_URGENCIA } from "../_shared/handoff-regras.ts";
import { respostaProibida } from "../_shared/pos-validacao.ts";
import {
  consentimentoLibera,
  interpretarConsentimento,
  MAX_LEMBRETES_CONSENTIMENTO,
  pedidoDeConversaAnterior,
  pedirConsentimento,
} from "../_shared/consentimento.ts";
import { dentroDoHorario, partesNoFuso, TZ_PADRAO } from "../_shared/horario.ts";
import { faseTeste } from "../_shared/ia-teste.ts";
import { decidirRajada, rajadaDoConfig } from "../_shared/rajada.ts";
import { decidirFollowup, followupsDoConfig, instrucaoFollowup, podeMandarFollowup, textoFollowupFixo } from "../_shared/ia-followup.ts";
import { dataHoraLocal, numerosAviso, textoAvisoAgendamento, textoAvisoCancelamento } from "../_shared/aviso-agendamento.ts";
import { ETAPA_CONFIRMACAO, horasConfirmacao, horasConfirmacaoCurta, MINIMO_ANTES_MS, precisaLembrete, STATUS_COM_LEMBRETE, textoConfirmacao } from "../_shared/confirmacao-agendamento.ts";
import { decidirEncerramento, ETAPA_ENCERRAMENTO, jaEncerrada, mensagensDaConversaAtual, minutosEncerramento } from "../_shared/ia-encerramento.ts";
import { detectarAgendamento, detectarNegociacao, type EventoFunil } from "../_shared/funil-ia.ts";
import {
  configRetomadaQueda,
  type ConfigRetomadaQueda,
  ETAPA_RETOMADA_QUEDA,
  eventoParaReprocessar,
  FOLGA_DESCONEXAO_MS,
  instrucaoRetomadaQueda,
  jaNoCrm,
  MARGEM_CASAMENTO_MS,
  mensagensDaQueda,
  podeRetomarAgora,
  PRAZO_COLETA_MS,
  retomadaVencida,
  selecionarChatsDaQueda,
  textoRetomadaQuedaFixo,
} from "../_shared/retomada-queda.ts";
import {
  calendarioDiasUteis,
  FERRAMENTAS,
  montarSystemPrompt,
  paraWhatsApp,
  partesDaResposta,
  sortear,
  TEXTOS_AGENDAMENTO_ANOTADO,
  TEXTOS_AGENDAMENTO_FALHOU,
  TEXTOS_CANCELAMENTO_FALHOU,
  TEXTOS_CONFIRMACAO_ANOTADA,
  TEXTOS_CONSENTIMENTO_NEGADO,
  TEXTOS_ENCERRAMENTO,
  TEXTOS_ERRO_TEMPORARIO,
  TEXTOS_LEMBRETE_CONSENTIMENTO,
  TEXTOS_RESPOSTA_BLOQUEADA,
  TEXTOS_VALOR_PESSOALMENTE,
  textoForaDoHorario,
  textoHorarioOcupado,
  textoPedidoConsentimento,
  TOOL_CANCELAR_AGENDAMENTO,
  TOOL_CONFIRMAR_AGENDAMENTO,
  TOOL_PROPOR_AGENDAMENTO,
  type ExemploConversa,
} from "../_shared/ia-prompt.ts";

// Exemplos de conversa no prompt (todos os de um funil cabem; ver SQL 35).
const MAX_EXEMPLOS = 25;

const LOG = "[ic-ia-pre-atendimento]";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_ANTHROPIC_MS = 25000;
// Quantas mensagens a IA le (crm_ia_config.contexto_mensagens, 5 a 60).
function limiteContexto(cfg: Record<string, string>): number {
  const n = Math.floor(Number(cfg.contexto_mensagens || "30"));
  return Number.isFinite(n) ? Math.min(60, Math.max(5, n)) : 30;
}

type Body = { cliente_crm_id: string; conversa_id: string | null; vendedor_id: string | null; funil_id: string | null };

// Um envio por vez (SQL 37, atender_um_por_vez): as conversas andam em paralelo
// (cada uma esperando os 30 s da rajada e a IA pensar), mas so UMA resposta e
// enviada de cada vez no numero. A trava ia_vez so e segurada durante o envio;
// o prazo e a rede de seguranca se a funcao cair no meio (cobre 3 partes com
// "digitando..." de ate 10 s cada, as pausas e o aviso a equipe).
const PRAZO_VEZ_S = 90;
// Entre as mensagens de uma resposta em partes: garante a ordem na Z-API, que
// mostra o "digitando..." de cada uma antes de entregar.
const PAUSA_ENTRE_MENSAGENS_MS = 2500;

type Contexto = {
  primeiro_nome: string | null;
  funil: string | null;
  etapa_label: string | null;
  consentimento: string | null;
  mensagens: Array<{ autor: string; exibicao: string | null; criada_em: string }>;
};

type MotivoHandoffDb =
  | "duvida_clinica" | "urgencia" | "reclamacao" | "pedido_humano"
  | "agendamento_confirmado" | "consentimento_negado" | "erro_ia" | "manual";

// ---------------------------------------------------------------------------
// Infra do pipeline: log de decisoes, handoffs, envio (com modo sombra).
// ---------------------------------------------------------------------------
class Pipeline {
  sb: SupabaseClient;
  body: Body;
  card: any = null;
  modelo = "claude-sonnet-5-5";
  envioLigado = false;
  canal: CanalEnvio | null = null;
  para = "";
  cfg: Record<string, string> = {};
  // Antes disso nao comeca a digitar: tempo de "leitura" da mensagem (marcarComoLidas).
  digitarDepoisDe = 0;
  private vezDono: string | null = null;
  private vezProfundidade = 0;
  constructor(sb: SupabaseClient, body: Body) {
    this.sb = sb;
    this.body = body;
  }

  // Roda `envio` com a vez de enviar (um envio por vez no numero). Reentrante:
  // as partes de uma resposta e o aviso a equipe saem na mesma vez.
  // false = nao conseguiu a vez a tempo (nada foi enviado).
  async comVez(envio: () => Promise<void>): Promise<boolean> {
    if (String(this.cfg.atender_um_por_vez ?? "true").toLowerCase() === "false" || this.vezProfundidade > 0) {
      this.vezProfundidade++;
      try { await envio(); } finally { this.vezProfundidade--; }
      return true;
    }
    const dono = crypto.randomUUID();
    const vez = await esperarVez(this.sb, dono, this.cfg);
    if (!vez.ok && !vez.erro) {
      await this.log("fila", "sem_vez", { detalhe: { esperou_ms: vez.esperou_ms } });
      return false;
    }
    if (!vez.ok) {
      // Sem conseguir ler a trava nao envia: nunca arrisca responder duas pessoas juntas.
      await this.log("fila", "sem_trava", { motivo: vez.erro });
      return false;
    }
    if (vez.esperou_ms > 1000) await this.log("fila", "vez", { detalhe: { esperou_ms: vez.esperou_ms } });
    this.vezDono = dono;
    this.vezProfundidade++;
    try {
      await envio();
    } finally {
      this.vezProfundidade--;
      if (this.vezDono) {
        const { error } = await this.sb.rpc("ic_ia_soltar_vez", { p_dono: this.vezDono });
        if (error) console.warn(LOG, "soltar a vez falhou (expira sozinha):", error.message);
        this.vezDono = null;
      }
    }
    return true;
  }

  async log(
    etapa: string,
    decisao: string,
    extra: Partial<{
      motivo: string | null;
      modelo: string | null;
      tokens_entrada: number | null;
      tokens_saida: number | null;
      latencia_ms: number | null;
      dados_enviados_resumo: Record<string, unknown> | null;
      resposta_enviada: boolean;
      detalhe: Record<string, unknown> | null;
    }> = {},
  ): Promise<string | null> {
    const linha = {
      cliente_crm_id: this.body.cliente_crm_id,
      conversa_id: this.body.conversa_id,
      etapa_pipeline: etapa,
      decisao,
      motivo: extra.motivo ?? null,
      modelo: extra.modelo ?? null,
      tokens_entrada: extra.tokens_entrada ?? null,
      tokens_saida: extra.tokens_saida ?? null,
      latencia_ms: extra.latencia_ms ?? null,
      dados_enviados_resumo: extra.dados_enviados_resumo ?? null,
      resposta_enviada: extra.resposta_enviada ?? false,
      detalhe: extra.detalhe ?? null,
    };
    try {
      const { data, error } = await this.sb.from("ia_decisoes_log").insert(linha).select("id").maybeSingle();
      if (error) {
        console.error(LOG, "ia_decisoes_log recusou:", error.message, etapa, decisao);
        return null;
      }
      return data && (data as any).id ? String((data as any).id) : null;
    } catch (e) {
      console.error(LOG, "excecao em ia_decisoes_log:", e);
      return null;
    }
  }

  // Cria handoff se nao houver um PENDENTE do mesmo motivo para o card.
  async handoff(motivo: MotivoHandoffDb, detalhe: string): Promise<boolean> {
    try {
      const { data: pend } = await this.sb
        .from("ia_handoffs")
        .select("id")
        .eq("cliente_crm_id", this.body.cliente_crm_id)
        .eq("motivo", motivo)
        .is("atendido_em", null)
        .limit(1);
      if (pend && pend.length) return false;
      const { error } = await this.sb.from("ia_handoffs").insert({
        cliente_crm_id: this.body.cliente_crm_id,
        motivo,
        detalhe: String(detalhe || "").slice(0, 500),
      });
      if (error) console.error(LOG, "ia_handoffs recusou:", error.message);
      return !error;
    } catch (e) {
      console.error(LOG, "excecao em ia_handoffs:", e);
      return false;
    }
  }

  // Quando foi aberto o handoff pendente mais antigo que cala a IA (ou null).
  // So a recusa do consentimento cala (handoffCalaIA); os outros sao historico.
  async handoffPendenteDesde(): Promise<string | null> {
    const { data, error } = await this.sb
      .from("ia_handoffs")
      .select("criado_em, motivo, detalhe")
      .eq("cliente_crm_id", this.body.cliente_crm_id)
      .is("atendido_em", null)
      .order("criado_em", { ascending: true })
      .limit(20);
    if (error) {
      console.warn(LOG, "ia_handoffs consulta falhou:", error.message);
      return null;
    }
    const cala = (data || []).find((h: any) => handoffCalaIA({ motivo: String(h.motivo) }));
    return cala ? String((cala as any).criado_em) : null;
  }

  async temHandoffPendente(): Promise<boolean> {
    return !!(await this.handoffPendenteDesde());
  }

  // Termina a "leitura" antes de pegar a vez (o tempo da IA pensar ja conta).
  async esperarLeitura(): Promise<void> {
    const falta = this.digitarDepoisDe - Date.now();
    this.digitarDepoisDe = 0;
    if (falta > 0) await new Promise((r) => setTimeout(r, falta));
  }

  // Resposta da IA em varias mensagens, como uma pessoa manda (partesDaResposta):
  // cada uma com "digitando..." do tamanho dela. Marcadores so na primeira.
  async enviarEmPartes(
    texto: string,
    etapa: string,
    decisaoOk: string,
    extra: Record<string, unknown> = {},
    marcadores: Record<string, unknown> = {},
  ): Promise<{ enviado: boolean; log_id: string | null }> {
    const partes = partesDaResposta(texto);
    if (partes.length <= 1) return await this.enviar(partes[0] || texto, etapa, decisaoOk, extra, marcadores);
    let primeiro: { enviado: boolean; log_id: string | null } | null = null;
    await this.esperarLeitura();
    const teveVez = await this.comVez(async () => {
      for (let i = 0; i < partes.length; i++) {
        if (i > 0 && this.envioLigado && this.canal) await new Promise((r) => setTimeout(r, PAUSA_ENTRE_MENSAGENS_MS));
        const r = await this.enviar(partes[i], etapa, decisaoOk, { ...extra, parte: i + 1, de: partes.length }, i === 0 ? marcadores : {});
        if (!primeiro) primeiro = r;
        if (!r.enviado && this.envioLigado && this.canal) break; // falhou: nao manda o resto fora de ordem
      }
    });
    if (!teveVez) await this.handoff("manual", "IA nao conseguiu a vez de enviar a resposta");
    return primeiro || { enviado: false, log_id: null };
  }

  // Envia (ou simula) uma resposta da IA. Grava crm_conversas so com wamid.
  async enviar(
    texto: string,
    etapa: string,
    decisaoOk: string,
    extra: Record<string, unknown> = {},
    marcadores: Record<string, unknown> = {},
  ): Promise<{ enviado: boolean; log_id: string | null }> {
    if (!this.envioLigado || !this.canal) {
      const log_id = await this.log(etapa, "simulada_envio_desligado", {
        modelo: this.modelo,
        resposta_enviada: false,
        detalhe: { resposta: texto, ...extra },
      });
      console.log(LOG, "MODO SOMBRA (nao enviado):", texto.slice(0, 120));
      return { enviado: false, log_id };
    }
    await this.esperarLeitura();
    // Sem assinatura: a IA fala em nome da equipe; o nome so aparece quando um
    // atendente assume (ic-whatsapp-send). "Digitando..." antes, onde o provedor tem.
    const canal = this.canal;
    const caixa: { r: Awaited<ReturnType<typeof enviarTextoCanal>> | null } = { r: null };
    const teveVez = await this.comVez(async () => {
      const t0 = Date.now();
      caixa.r = await enviarTextoCanal(canal, this.para, texto, LOG, { simularDigitacao: true });
      // A Z-API pode devolver antes de terminar o "digitando...": segura a vez
      // ate a mensagem sair, para nunca haver duas conversas digitando juntas.
      if (caixa.r?.ok && canal?.provedor === "zapi") {
        const falta = segundosDigitando(texto) * 1000 + 1000 - (Date.now() - t0);
        if (falta > 0) await new Promise((r) => setTimeout(r, falta));
      }
    });
    const envio = caixa.r;
    if (!teveVez || !envio) {
      await this.handoff("manual", "IA nao conseguiu a vez de enviar a resposta");
      return { enviado: false, log_id: null };
    }
    if (!envio.ok) {
      const log_id = await this.log(etapa, "erro_envio", {
        modelo: this.modelo,
        resposta_enviada: false,
        detalhe: { resposta: texto, provedor: this.canal.provedor, codigo_meta: envio.codigoMeta, status: envio.status, ...extra },
      });
      return { enviado: false, log_id };
    }
    const log_id = await this.log(etapa, decisaoOk, { modelo: this.modelo, resposta_enviada: true, detalhe: extra });
    const agoraIso = new Date().toISOString();
    const { error } = await this.sb.from("crm_conversas").insert({
      cliente_crm_id: this.body.cliente_crm_id,
      vendedor_id: this.card?.vendedor_id ?? this.body.vendedor_id,
      numero_lead: this.para,
      direcao: "enviada",
      autor: "ia",
      mensagem: texto,
      tipo: "texto",
      zapi_message_id: envio.wamid,
      criada_em: agoraIso,
      payload_raw: { ia: true, modelo: this.modelo, provedor: this.canal.provedor, decisao_log_id: log_id, ...marcadores },
    });
    if (error) console.error(LOG, "crm_conversas (ia) recusou:", error.message);
    const { error: errUpd } = await this.sb
      .from("clientes_crm")
      .update({ ultima_mensagem_em: agoraIso, ultima_mensagem_direcao: "enviada" })
      .eq("id", this.body.cliente_crm_id);
    if (errUpd) console.warn(LOG, "update clientes_crm falhou:", errUpd.message);
    return { enviado: true, log_id };
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (fetch direto; a especificacao pediu fetch, nao SDK).
// ---------------------------------------------------------------------------
type RespostaClaude = {
  texto: string;
  tools: Array<{ id: string; name: string; input: any }>;
  stop_reason: string;
  tokens_entrada: number | null;
  tokens_saida: number | null;
  latencia_ms: number;
  erro: string | null;
};

function mensagensParaClaude(ctx: Contexto): Array<{ role: "user" | "assistant"; content: string }> {
  // lead -> user; vendedor/ia -> assistant. Mescla consecutivas para manter a
  // alternancia valida e garante que comeca com user e termina com user.
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of ctx.mensagens || []) {
    const txt = String(m.exibicao || "").trim();
    if (!txt) continue;
    const role: "user" | "assistant" = String(m.autor || "").toLowerCase() === "lead" ? "user" : "assistant";
    const ult = out[out.length - 1];
    if (ult && ult.role === role) ult.content += "\n" + txt;
    else out.push({ role, content: txt });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length) return [];
  if (out[out.length - 1].role !== "user") {
    // O lead nao falou por ultimo: nada a responder. Sinaliza com lista vazia.
    return [];
  }
  return out;
}

async function chamarClaude(args: {
  apiKey: string;
  modelo: string;
  maxTokens: number;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<RespostaClaude> {
  const inicio = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_ANTHROPIC_MS);
  const vazio = (erro: string): RespostaClaude => ({
    texto: "", tools: [], stop_reason: "erro", tokens_entrada: null, tokens_saida: null, latencia_ms: Date.now() - inicio, erro,
  });
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": args.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: args.modelo,
        max_tokens: args.maxTokens,
        system: args.system,
        messages: args.messages,
        tools: FERRAMENTAS,
        tool_choice: { type: "auto" },
        output_config: { effort: "low" },
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data && data.error && data.error.message ? String(data.error.message) : `HTTP ${resp.status}`;
      console.error(LOG, "Anthropic devolveu", resp.status, msg.slice(0, 300));
      return vazio(`http_${resp.status}`);
    }
    const stop = String(data.stop_reason || "");
    let texto = "";
    const tools: Array<{ id: string; name: string; input: any }> = [];
    for (const b of Array.isArray(data.content) ? data.content : []) {
      if (b && b.type === "text" && b.text) texto += (texto ? "\n" : "") + String(b.text);
      if (b && b.type === "tool_use") tools.push({ id: String(b.id), name: String(b.name), input: b.input ?? {} });
    }
    return {
      texto: texto.trim(),
      tools,
      stop_reason: stop,
      tokens_entrada: data.usage && data.usage.input_tokens != null ? Number(data.usage.input_tokens) : null,
      tokens_saida: data.usage && data.usage.output_tokens != null ? Number(data.usage.output_tokens) : null,
      latencia_ms: Date.now() - inicio,
      erro: stop === "refusal" ? "refusal" : null,
    };
  } catch (e) {
    clearTimeout(t);
    const abortado = e instanceof Error && e.name === "AbortError";
    console.error(LOG, "Anthropic fetch falhou:", abortado ? "timeout" : (e instanceof Error ? e.message : e));
    return vazio(abortado ? "timeout" : "fetch");
  }
}

// ---------------------------------------------------------------------------
// Pipeline principal
// ---------------------------------------------------------------------------
async function rodar(sb: SupabaseClient, body: Body): Promise<Record<string, unknown>> {
  const p = new Pipeline(sb, body);

  // 1) flags
  const flagIa = await icFlag(sb, "ia_pre_atendimento");
  const cfg = await iaConfig(sb);
  p.modelo = cfg.modelo || "claude-sonnet-5-5";
  p.cfg = cfg;
  if (!flagIa || String(cfg.ligada).toLowerCase() !== "true") {
    await p.log("flags", "desligada", { detalhe: { flag: flagIa, config_ligada: cfg.ligada } });
    return { ok: true, decisao: "desligada" };
  }
  await p.log("flags", "ligada");

  // Card (dados minimos, nada sensivel sai daqui).
  const { data: card, error: errCard } = await sb
    .from("clientes_crm")
    .select("id, nome, numero_whatsapp, telefone, vendedor_id, vendedor_nome, funil_id, etapa, deleted_at")
    .eq("id", body.cliente_crm_id)
    .maybeSingle();
  if (errCard || !card) {
    await p.log("flags", "card_nao_encontrado", { motivo: errCard ? errCard.message : null });
    return { ok: false, erro: "card_nao_encontrado" };
  }
  p.card = card;
  p.para = canonicoTelefone(String((card as any).numero_whatsapp || (card as any).telefone || ""));
  if (!telefoneBrPlausivel(p.para)) {
    await p.log("flags", "card_sem_numero");
    return { ok: false, erro: "card_sem_numero" };
  }

  // Fase de teste (crm_ia_config.numeros_teste / modo_sombra, _shared/ia-teste.ts).
  const fase = faseTeste(cfg, p.para);
  if (!fase.atende) {
    await p.log("flags", "fora_dos_numeros_teste");
    return { ok: true, decisao: "fora_dos_numeros_teste" };
  }

  // Rajada (_shared/rajada.ts): espera a pessoa parar de digitar; so a
  // invocacao da ultima mensagem responde, lendo todas juntas.
  if (body.conversa_id) {
    const rajada = rajadaDoConfig(cfg);
    const inicioEspera = Date.now();
    for (;;) {
      const { data: ult, error: errUlt } = await sb
        .from("crm_conversas")
        .select("id, criada_em")
        .eq("cliente_crm_id", body.cliente_crm_id)
        .eq("direcao", "recebida")
        .order("criada_em", { ascending: false })
        .limit(1);
      if (errUlt) console.warn(LOG, "rajada: leitura falhou (segue):", errUlt.message);
      const linha = !errUlt && ult && ult.length ? { id: String(ult[0].id), criada_em: String(ult[0].criada_em) } : null;
      const d = decidirRajada({
        gatilhoId: String(body.conversa_id), ultimaDoLead: linha, agoraMs: Date.now(), inicioEsperaMs: inicioEspera,
        silencioMs: rajada.silencioMs, tetoMs: rajada.tetoMs,
      });
      if (d.acao === "absorvida") {
        await p.log("rajada", "absorvida", { detalhe: { esperou_ms: Date.now() - inicioEspera } });
        return { ok: true, decisao: "absorvida_na_rajada" };
      }
      if (d.acao === "responder") break;
      await new Promise((r) => setTimeout(r, d.ms));
    }
  }

  return await rodarNaVez(sb, body, p, cfg, card, fase);
}

// Espera a vez de ENVIAR (trava ia_vez), consultando a cada 0,5 s ate
// fila_espera_segundos (padrao 35). erro = ultima falha ao ler a trava (nesse caso nao envia).
async function esperarVez(sb: SupabaseClient, dono: string, cfg: Record<string, string>): Promise<{ ok: boolean; erro: string | null; esperou_ms: number }> {
  const inicio = Date.now();
  const n = Number(cfg.fila_espera_segundos || "35");
  const limiteMs = (Number.isFinite(n) ? Math.min(60, Math.max(5, n)) : 35) * 1000;
  for (;;) {
    const { data, error } = await sb.rpc("ic_ia_pegar_vez", { p_dono: dono, p_segundos: PRAZO_VEZ_S });
    if (!error && data === true) return { ok: true, erro: null, esperou_ms: Date.now() - inicio };
    // Erro passageiro ao ler a trava: tenta de novo ate o prazo.
    if (Date.now() - inicio >= limiteMs) return { ok: false, erro: error ? error.message : null, esperou_ms: Date.now() - inicio };
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Marca como lidas as mensagens do lead desde a ultima resposta e define o tempo
// de leitura (msLeitura) antes do "digitando...". So na Z-API e com envio ligado.
async function marcarComoLidas(sb: SupabaseClient, p: Pipeline): Promise<void> {
  if (!p.envioLigado || !p.canal || p.canal.provedor !== "zapi") return;
  const { data } = await sb
    .from("crm_conversas")
    .select("direcao, mensagem, zapi_message_id")
    .eq("cliente_crm_id", p.body.cliente_crm_id)
    .order("criada_em", { ascending: false })
    .limit(10);
  const novas: any[] = [];
  for (const m of (data as any[]) || []) {
    if (m.direcao !== "recebida") break;
    novas.push(m);
  }
  if (!novas.length) return;
  const canal = p.canal;
  // Da mais antiga para a mais nova, no maximo 5 (a ultima marca o resto no aparelho).
  for (const m of novas.slice(0, 5).reverse()) {
    if (m.zapi_message_id) await lerMensagemZapi(canal, p.para, String(m.zapi_message_id), LOG);
  }
  const caracteres = novas.reduce((n, m) => n + String(m.mensagem || "").length, 0);
  p.digitarDepoisDe = Date.now() + msLeitura(caracteres);
}

// Resto do pipeline (depois da rajada).
async function rodarNaVez(
  sb: SupabaseClient, body: Body, p: Pipeline, cfg: Record<string, string>, card: any, fase: ReturnType<typeof faseTeste>,
): Promise<Record<string, unknown>> {
  // Envio (antes do humano_assumiu, que pode mandar o aviso de espera):
  // flag + canal (provedor, numero e credencial) do vendedor do card.
  // Sem isso = modo sombra.
  p.envioLigado = !fase.sombra && await icFlag(sb, "envio_whatsapp_cloud_api");
  const vendedorId = String((card as any).vendedor_id || body.vendedor_id || "");
  let motivoSemCanal = "card_sem_vendedor";
  if (vendedorId) {
    const res = await canalDoVendedor(sb, vendedorId);
    if (res.ok) p.canal = res.canal;
    else motivoSemCanal = res.erroBanco ? "erro_banco" : res.motivo;
  }
  if (!p.envioLigado || !p.canal) {
    console.log(LOG, "modo sombra:", { config_sombra: fase.sombra, flag: p.envioLigado, provedor: p.canal?.provedor ?? null, motivo: p.canal ? null : motivoSemCanal });
  }

  // 2) humano_assumiu
  // O encerramento (por inatividade ou pela equipe, SQL 32) abre conversa nova:
  // o que o vendedor disse antes dele nao cala a IA.
  const inicioConversa = await ultimoEncerramento(sb, body.cliente_crm_id);
  const ha24h = Date.now() - 24 * 3600 * 1000;
  const inicioMs = inicioConversa ? Date.parse(inicioConversa) : NaN;
  const desde24h = new Date(Number.isFinite(inicioMs) ? Math.max(ha24h, inicioMs) : ha24h).toISOString();
  const { data: humano } = await sb
    .from("crm_conversas")
    .select("id")
    .eq("cliente_crm_id", body.cliente_crm_id)
    .eq("direcao", "enviada")
    .eq("autor", "vendedor")
    .gt("criada_em", desde24h)
    .limit(1);
  if (humano && humano.length) {
    await p.log("humano_assumiu", "humano_no_controle", { motivo: "vendedor respondeu nas ultimas 24h" });
    return { ok: true, decisao: "humano_no_controle" };
  }
  const handoffDesde = await p.handoffPendenteDesde();
  if (handoffDesde) {
    // So a recusa do atendimento automatizado chega aqui (handoffCalaIA): silencio.
    await p.log("humano_assumiu", "consentimento_negado_pendente");
    return { ok: true, decisao: "consentimento_negado" };
  }
  await p.log("humano_assumiu", "ia_pode_responder");

  // 3) limites
  const agora = new Date();
  // atender_fora_do_horario (padrao true, SQL 37): a IA responde a qualquer
  // hora; o expediente so limita os horarios que ela agenda.
  const atendeSempre = String(cfg.atender_fora_do_horario ?? "true").toLowerCase() !== "false";
  if (!atendeSempre && !dentroDoHorario(agora, cfg.horario_inicio || "08:00", cfg.horario_fim || "19:00", TZ_PADRAO)) {
    const hoje = partesNoFuso(agora, TZ_PADRAO);
    // Inicio do dia local em UTC: Sao Paulo = UTC-3 fixo; usa Date.UTC(dia, 03:00).
    const inicioDiaIso = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia, 3, 0, 0)).toISOString();
    const { data: jaAvisou } = await sb
      .from("crm_conversas")
      .select("id")
      .eq("cliente_crm_id", body.cliente_crm_id)
      .eq("autor", "ia")
      .gte("criada_em", inicioDiaIso)
      .contains("payload_raw", { fora_horario: true })
      .limit(1);
    if (jaAvisou && jaAvisou.length) {
      await p.log("limites", "fora_horario_ja_avisado");
      return { ok: true, decisao: "fora_horario_ja_avisado" };
    }
    await p.enviar(textoForaDoHorario(), "limites", "fora_horario_enviada", {}, { fora_horario: true });
    return { ok: true, decisao: "fora_horario" };
  }
  // Conta so as respostas da conversa atual: o encerramento por inatividade
  // abre uma conversa nova.
  const maxRespostas = Math.max(1, Number(cfg.max_respostas_por_conversa || "6") || 6);
  let qRespostas = sb
    .from("ia_decisoes_log")
    .select("id", { count: "exact", head: true })
    .eq("cliente_crm_id", body.cliente_crm_id)
    .eq("resposta_enviada", true);
  if (inicioConversa) qRespostas = qRespostas.gt("criado_em", inicioConversa);
  const { count: respostasDadas } = await qRespostas;
  if ((respostasDadas || 0) >= maxRespostas) {
    await p.handoff("manual", "limite de respostas da IA");
    await p.log("limites", "limite_respostas", { motivo: `${respostasDadas}/${maxRespostas}` });
    return { ok: true, decisao: "limite_respostas" };
  }
  await p.log("limites", "ok", { detalhe: { respostas: respostasDadas || 0, max: maxRespostas } });

  // Como uma pessoa: abre a conversa (tracinhos azuis) e le antes de digitar.
  await marcarComoLidas(sb, p);

  // 4) contexto
  const { data: ctxRaw, error: errCtx } = await sb.rpc("ic_ia_contexto", {
    p_cliente: body.cliente_crm_id,
    p_limite: limiteContexto(cfg),
  });
  if (errCtx || !ctxRaw) {
    await p.log("contexto", "erro", { motivo: errCtx ? errCtx.message : "vazio" });
    return { ok: false, erro: "contexto" };
  }
  const ctx = ctxRaw as Contexto;
  ctx.mensagens = Array.isArray(ctx.mensagens) ? ctx.mensagens : [];
  // Conversa encerrada nao volta: a IA so ve o que veio depois do encerramento.
  ctx.mensagens = mensagensDaConversaAtual(ctx.mensagens, inicioConversa);
  const ultimaDoLead = [...ctx.mensagens].reverse().find((m) => String(m.autor || "").toLowerCase() === "lead");
  const textoLead = String((ultimaDoLead && ultimaDoLead.exibicao) || "").trim();
  await p.log("contexto", "ok", {
    dados_enviados_resumo: { mensagens: ctx.mensagens.length, tem_nome: !!ctx.primeiro_nome, tem_funil: !!ctx.funil },
  });
  if (!textoLead) {
    await p.log("contexto", "sem_mensagem_do_lead");
    return { ok: true, decisao: "sem_mensagem_do_lead" };
  }

  // 5) consentimento (LGPD)
  // Desligado (crm_ia_config.pedir_consentimento diferente de 'true'), a
  // Julie abre a conversa se apresentando, sem pedir autorizacao.
  if (!pedirConsentimento(cfg)) {
    await p.log("consentimento", "dispensado");
  } else {
    // Vale o registro MAIS RECENTE (o historico de respostas fica guardado).
    const { data: consRows } = await sb
      .from("ia_consentimentos")
      .select("id, status, texto_apresentado, respondido_em, criado_em")
      .eq("cliente_crm_id", body.cliente_crm_id)
      .order("criado_em", { ascending: false })
      .limit(1);
    let cons: any = consRows && consRows[0] ? consRows[0] : null;
    let statusCons = String((cons && cons.status) || ctx.consentimento || "pendente").toLowerCase();

    if (statusCons === "negado" || statusCons === "revogado") {
      // Recusou, a conversa foi encerrada depois e o lead voltou a escrever:
      // conversa nova, pede a autorizacao de novo (registro novo, a recusa fica).
      const recusaMs = cons ? Date.parse(String(cons.respondido_em || cons.criado_em || "")) : NaN;
      const encerrouDepois = Number.isFinite(inicioMs) && (!Number.isFinite(recusaMs) || inicioMs > recusaMs);
      if (!encerrouDepois) {
        await p.log("consentimento", "negado_anteriormente");
        return { ok: true, decisao: "consentimento_negado" };
      }
      const { data: novo, error: errNovo } = await sb
        .from("ia_consentimentos")
        .insert({ cliente_crm_id: body.cliente_crm_id, telefone_norm: p.para, status: "pendente" })
        .select("id, status, texto_apresentado")
        .maybeSingle();
      if (errNovo || !novo) {
        console.error(LOG, "ia_consentimentos (novo pedido) falhou:", errNovo ? errNovo.message : "sem retorno");
        await p.log("consentimento", "negado_anteriormente", { motivo: "novo pedido falhou" });
        return { ok: true, decisao: "consentimento_negado" };
      }
      await p.log("consentimento", "pedido_de_novo_apos_encerramento");
      cons = novo;
      statusCons = "pendente";
    }
    if (statusCons === "pendente" && cons && cons.texto_apresentado && pedidoDeConversaAnterior(cons.criado_em, inicioMs)) {
      // Pedido feito numa conversa ja encerrada: a pessoa voltou do zero. Pede
      // de novo (registro novo, o antigo fica no historico).
      const { data: novo, error: errNovo } = await sb
        .from("ia_consentimentos")
        .insert({ cliente_crm_id: body.cliente_crm_id, telefone_norm: p.para, status: "pendente" })
        .select("id, status, texto_apresentado")
        .maybeSingle();
      if (errNovo || !novo) {
        console.error(LOG, "ia_consentimentos (novo pedido) falhou:", errNovo ? errNovo.message : "sem retorno");
      } else {
        await p.log("consentimento", "pedido_de_novo_conversa_nova");
        cons = novo;
      }
    }
    if (statusCons === "pendente") {
      const jaPediu = !!(cons && cons.texto_apresentado);
      if (!jaPediu) {
        const texto = textoPedidoConsentimento(Deno.env.get("IC_POLITICA_PRIVACIDADE_URL") || "");
        const r = await p.enviar(texto, "consentimento", "pedido_enviado");
        // Registra o texto apresentado mesmo em modo sombra (marca "simulado" no canal).
        const canal = r.enviado ? "whatsapp" : "whatsapp_simulado";
        if (cons) {
          await sb.from("ia_consentimentos").update({ texto_apresentado: texto, canal }).eq("id", cons.id);
        } else {
          const { error } = await sb.from("ia_consentimentos").insert({
            cliente_crm_id: body.cliente_crm_id,
            telefone_norm: p.para,
            status: "pendente",
            texto_apresentado: texto,
            canal,
          });
          if (error) console.error(LOG, "ia_consentimentos insert falhou:", error.message);
        }
        return { ok: true, decisao: "consentimento_pedido" };
      }
      const resp = interpretarConsentimento(textoLead);
      if (resp === "nao") {
        await sb.from("ia_consentimentos").update({ status: "negado", respondido_em: new Date().toISOString() }).eq("id", cons.id);
        await p.handoff("consentimento_negado", "lead nao autorizou atendimento automatizado");
        await p.enviar(sortear(TEXTOS_CONSENTIMENTO_NEGADO), "consentimento", "negado_despedida");
        return { ok: true, decisao: "consentimento_negado" };
      }
      if (resp === "ambiguo") {
        // Urgencia ou duvida clinica no lugar do sim/nao: texto fixo (CFM), sem
        // registrar consentimento.
        const hdCons = detectarHandoff(textoLead);
        const fixoCons = hdCons ? textoFixoRegra(hdCons.motivo) : null;
        if (hdCons && fixoCons) {
          if (hdCons.motivo === "urgencia") await p.handoff("urgencia", `regra '${hdCons.termo}' na resposta ao consentimento`);
          await p.log("consentimento", "ambiguo_com_regra", { motivo: hdCons.termo });
          await p.enviar(fixoCons, "envio", "enviada_fixa", { origem: "consentimento", motivo: hdCons.motivo });
          return { ok: true, decisao: "regra_" + hdCons.motivo };
        }
        // Nem sim nem nao (ex.: a pessoa ja conta o que precisa): nunca deixa sem
        // resposta. Acolhe e pede o ok de novo, ate MAX_LEMBRETES_CONSENTIMENTO
        // vezes nesta conversa.
        let qLembretes = sb
          .from("ia_decisoes_log")
          .select("id", { count: "exact", head: true })
          .eq("cliente_crm_id", body.cliente_crm_id)
          .eq("etapa_pipeline", "consentimento")
          .eq("decisao", "lembrete_enviado");
        if (inicioConversa) qLembretes = qLembretes.gt("criado_em", inicioConversa);
        const { count: lembretes } = await qLembretes;
        if ((lembretes || 0) < MAX_LEMBRETES_CONSENTIMENTO) {
          await p.enviar(sortear(TEXTOS_LEMBRETE_CONSENTIMENTO), "consentimento", "lembrete_enviado");
          return { ok: true, decisao: "consentimento_lembrete" };
        }
        await p.log("consentimento", "ambiguo");
        return { ok: true, decisao: "consentimento_ambiguo" };
      }
      await sb.from("ia_consentimentos").update({ status: "concedido", respondido_em: new Date().toISOString() }).eq("id", cons.id);
      await p.log("consentimento", "concedido");
      // A mensagem "sim" ja foi consumida como consentimento; se ela nao traz mais
      // nada, segue para a IA responder acolhendo (o contexto inteiro vai junto).
    } else {
      await p.log("consentimento", "ja_concedido");
    }
  }

  // 6) handoff_regras (codigo, antes da IA)
  const hd = detectarHandoff(textoLead);
  const fixo = hd ? textoFixoRegra(hd.motivo) : null;
  if (hd && fixo) {
    // Urgencia fica registrada em ia_handoffs (historico no CRM; nao cala a IA).
    if (hd.motivo === "urgencia") await p.handoff("urgencia", `regra '${hd.termo}'`);
    await p.log("handoff_regras", hd.motivo, { motivo: hd.termo });
    await p.enviar(fixo, "envio", "enviada_fixa", { origem: "handoff_regras", motivo: hd.motivo });
    return { ok: true, decisao: "regra_" + hd.motivo };
  }
  // Reclamacao e pedido de humano: a IA conduz (prompt), so fica no log.
  await p.log("handoff_regras", hd ? hd.motivo + "_ia_conduz" : "nenhuma", hd ? { motivo: hd.termo } : {});

  // 7) exemplos
  let exemplos: ExemploConversa[] = [];
  try {
    const { data: ex } = await sb
      .from("ia_exemplos_conversa")
      .select("titulo, contexto, mensagem_lead, resposta_ideal, tags")
      .eq("ativo", true)
      .order("titulo")
      .limit(40);
    const todos = ((ex as any[]) || []).filter((e) => e && e.mensagem_lead && e.resposta_ideal);
    const funilNorm = String(ctx.funil || "").toLowerCase();
    const casam = funilNorm
      ? todos.filter((e) => Array.isArray(e.tags) && e.tags.some((t: string) => funilNorm.includes(String(t).toLowerCase()) || String(t).toLowerCase().includes(funilNorm)))
      : [];
    exemplos = (casam.length ? casam : todos).slice(0, MAX_EXEMPLOS);
  } catch (e) {
    console.warn(LOG, "ia_exemplos_conversa falhou (segue sem exemplos):", e);
  }
  await p.log("exemplos", "ok", { detalhe: { carregados: exemplos.length } });

  // 8) claude
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!apiKey) {
    await p.log("claude", "sem_chave");
    return { ok: false, erro: "sem_anthropic_api_key" };
  }
  const messages = mensagensParaClaude(ctx);
  if (!messages.length) {
    await p.log("claude", "sem_turno_do_lead");
    return { ok: true, decisao: "sem_turno_do_lead" };
  }
  const agoraSp = partesNoFuso(agora, TZ_PADRAO);
  const nomesDia = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const agoraLocal = `${nomesDia[agoraSp.diaSemana]}, ${String(agoraSp.dia).padStart(2, "0")}/${String(agoraSp.mes).padStart(2, "0")}/${agoraSp.ano} ${String(agoraSp.hora).padStart(2, "0")}:${String(agoraSp.minuto).padStart(2, "0")}`;
  const system = montarSystemPrompt({
    primeiroNome: ctx.primeiro_nome ? String(ctx.primeiro_nome).split(/\s+/)[0] : null,
    funil: ctx.funil,
    etapa: ctx.etapa_label,
    exemplos,
    agoraLocal,
    calendario: calendarioDiasUteis(agoraSp.ano, agoraSp.mes, agoraSp.dia),
    persona: { nome: cfg.persona_nome, ficha: cfg.persona_ficha },
  });
  const maxTokens = Math.max(256, Number(cfg.max_tokens || "1024") || 1024);
  const r = await chamarClaude({ apiKey, modelo: p.modelo, maxTokens, system, messages });
  const resumo = {
    mensagens: messages.length,
    chars_mensagens: messages.reduce((a, m) => a + m.content.length, 0),
    exemplos: exemplos.length,
    campos: ["primeiro_nome", "funil", "etapa"],
  };
  if (r.erro || (!r.texto && !r.tools.length)) {
    await p.log("claude", "erro", {
      modelo: p.modelo, motivo: r.erro || r.stop_reason, tokens_entrada: r.tokens_entrada, tokens_saida: r.tokens_saida,
      latencia_ms: r.latencia_ms, dados_enviados_resumo: resumo,
    });
    await p.handoff("erro_ia", "falha na chamada do modelo: " + (r.erro || r.stop_reason));
    await p.enviar(sortear(TEXTOS_ERRO_TEMPORARIO), "envio", "enviada_fixa", { origem: "erro_ia" });
    return { ok: true, decisao: "erro_ia" };
  }
  await p.log("claude", "respondeu", {
    modelo: p.modelo, tokens_entrada: r.tokens_entrada, tokens_saida: r.tokens_saida, latencia_ms: r.latencia_ms,
    dados_enviados_resumo: resumo, detalhe: { stop_reason: r.stop_reason, tools: r.tools.map((t) => t.name), chars_resposta: r.texto.length },
  });

  // 9) pos_validacao
  let textoResposta = paraWhatsApp(r.texto);
  const proibido = textoResposta ? respostaProibida(textoResposta) : null;
  if (proibido) {
    await p.log("pos_validacao", "bloqueada_pos_validacao", { modelo: p.modelo, motivo: proibido, detalhe: { resposta: textoResposta } });
    await p.handoff("erro_ia", "resposta bloqueada");
    const fixo = proibido.startsWith("valor:") ? sortear(TEXTOS_VALOR_PESSOALMENTE) : sortear(TEXTOS_RESPOSTA_BLOQUEADA);
    await p.enviar(fixo, "envio", "enviada_fixa", { origem: "pos_validacao", termo: proibido });
    return { ok: true, decisao: "bloqueada_pos_validacao" };
  }
  await p.log("pos_validacao", textoResposta ? "ok" : "sem_texto");

  // O lead escreveu de novo enquanto a IA pensava: quem responde e a invocacao
  // da mensagem nova (le tudo junto). Esta desiste antes de agendar ou enviar,
  // para nunca sairem duas respostas cruzadas.
  if (body.conversa_id && (await chegouMensagemNova(sb, body.cliente_crm_id, String(body.conversa_id)))) {
    await p.log("rajada", "absorvida_depois_da_ia");
    return { ok: true, decisao: "absorvida_na_rajada" };
  }

  // 10) tools
  const marcadores: Record<string, unknown> = {};
  for (const t of r.tools) {
    if (t.name === TOOL_PROPOR_AGENDAMENTO) {
      const resultado = await proporAgendamento(body.cliente_crm_id, t.input || {});
      await p.log("tools", resultado.ok ? "propor_agendamento" : "propor_agendamento_falhou", {
        motivo: resultado.ok ? null : resultado.erro, detalhe: { agendamento_id: resultado.agendamento_id, inicio: resultado.inicio, atualizado: resultado.atualizado },
      });
      if (resultado.ok) {
        if (!textoResposta) textoResposta = sortear(TEXTOS_AGENDAMENTO_ANOTADO);
        marcadores.agendamento_id = resultado.agendamento_id;
        // Agendou: fica o handoff agendamento_confirmado (historico no CRM; a IA segue).
        await p.handoff("agendamento_confirmado", `IA agendou ${resultado.inicio ? dataHoraLocal(resultado.inicio) : ""} (agendamento ${resultado.agendamento_id})`);
        await avisarEquipeAgendamento(p, cfg, t.input || {}, resultado);
      } else if (resultado.erro === "horario_ocupado") {
        // A IA ja tinha escrito "reservado": troca pelo aviso com horarios livres.
        textoResposta = textoHorarioOcupado(resultado.sugestoes.map((iso) => dataHoraLocal(iso)));
      } else {
        // A IA ja tinha escrito "reservado": troca por um pedido de outro horario.
        textoResposta = sortear(TEXTOS_AGENDAMENTO_FALHOU);
      }
    } else if (t.name === TOOL_CANCELAR_AGENDAMENTO) {
      // O lead manteve a decisao depois de a IA acolher e tentar manter ou remarcar.
      const motivoCancel = String(t.input?.motivo || "").trim().slice(0, 200);
      const cancel = await cancelarAgendamentoDoLead(body.cliente_crm_id, motivoCancel);
      await p.log("tools", cancel.ok ? "cancelar_agendamento" : "cancelar_agendamento_falhou", {
        motivo: cancel.ok ? null : cancel.erro, detalhe: { agendamento_id: cancel.agendamento_id, inicio: cancel.inicio },
      });
      if (cancel.ok) {
        marcadores.cancelado_id = cancel.agendamento_id;
        await avisarEquipeCancelamento(p, cfg, cancel, motivoCancel);
      } else if (cancel.erro !== "sem_agendamento") {
        // A IA ja tinha escrito "cancelei": nao afirma o que nao aconteceu.
        textoResposta = sortear(TEXTOS_CANCELAMENTO_FALHOU);
      }
    } else if (t.name === TOOL_CONFIRMAR_AGENDAMENTO) {
      // O lead confirmou a presenca (em geral respondendo ao lembrete de confirmacao).
      const conf = await confirmarAgendamentoDoLead(body.cliente_crm_id);
      await p.log("tools", conf.ok ? "confirmar_agendamento" : "confirmar_agendamento_falhou", {
        motivo: conf.ok ? null : conf.erro, detalhe: { agendamento_id: conf.agendamento_id, inicio: conf.inicio, ja_confirmado: conf.ja_confirmado },
      });
      if (conf.ok) {
        marcadores.confirmado_id = conf.agendamento_id;
        if (!textoResposta) textoResposta = sortear(TEXTOS_CONFIRMACAO_ANOTADA);
      }
    } else {
      await p.log("tools", "ferramenta_desconhecida", { motivo: t.name });
    }
  }
  if (!textoResposta) {
    await p.log("envio", "sem_texto");
    return { ok: true, decisao: "sem_texto" };
  }

  // 11) envio
  const env = await p.enviarEmPartes(textoResposta, "envio", "enviada", { tools: r.tools.map((t) => t.name) }, marcadores);

  // 12) funil: o card anda sozinho, so para frente (SQL 33). Desliga com
  // crm_ia_config.funil_automatico = 'false' (o card volta a so mudar na mao).
  const funilAuto = String(cfg.funil_automatico ?? "true").toLowerCase() !== "false";
  if (funilAuto && env.enviado) await avancarEtapa(sb, p, body.cliente_crm_id, "conversa", "a IA respondeu o lead");
  const termoNegociacao = funilAuto ? detectarNegociacao(textoLead) : null;
  if (termoNegociacao) await avancarEtapa(sb, p, body.cliente_crm_id, "negociacao", `lead perguntou sobre "${termoNegociacao}"`);
  if (funilAuto && marcadores.agendamento_id) await avancarEtapa(sb, p, body.cliente_crm_id, "proposta", "a IA propôs um horário");
  else if (funilAuto && env.enviado) {
    // A conversa entrou em agendamento (pedido de marcar, dia/horario): o card
    // ja vai para agendamento pendente, sem esperar a reserva do horario.
    const motivoAgenda = detectarAgendamento(textoLead, textoResposta);
    if (motivoAgenda) await avancarEtapa(sb, p, body.cliente_crm_id, "proposta", motivoAgenda);
  }

  return { ok: true, decisao: env.enviado ? "enviada" : "simulada_envio_desligado" };
}

// Move o card para a etapa ligada ao evento (ic_avancar_etapa, so para frente).
// Falha aqui nunca derruba a conversa: so registra no log.
async function avancarEtapa(sb: SupabaseClient, p: Pipeline, clienteId: string, evento: EventoFunil, motivo: string): Promise<void> {
  const { data, error } = await sb.rpc("ic_avancar_etapa", {
    p_cliente: clienteId, p_evento: evento, p_autor: "Assistente virtual", p_motivo: motivo,
  });
  if (error) {
    await p.log("funil", "falhou", { motivo: error.message, detalhe: { evento } });
  } else if (data) {
    await p.log("funil", "etapa_avancada", { detalhe: { evento, etapa_nova: data, motivo } });
  }
}

// Quando a conversa do card foi encerrada pela ultima vez (ou null).
async function ultimoEncerramento(sb: SupabaseClient, clienteId: string): Promise<string | null> {
  const { data, error } = await sb
    .from("ia_decisoes_log")
    .select("criado_em")
    .eq("cliente_crm_id", clienteId)
    .eq("etapa_pipeline", ETAPA_ENCERRAMENTO)
    .order("criado_em", { ascending: false })
    .limit(1);
  if (error) {
    console.warn(LOG, "ultimo encerramento falhou:", error.message);
    return null;
  }
  return data && data.length ? String((data[0] as any).criado_em) : null;
}

// Encerra as conversas em que a IA falou por ultimo e o lead nao respondeu
// dentro de encerrar_apos_minutos. Chamado pelo varredor (1x por minuto).
async function encerrarInativas(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const flagIa = await icFlag(sb, "ia_pre_atendimento");
  const cfg = await iaConfig(sb);
  if (!flagIa || String(cfg.ligada).toLowerCase() !== "true") return { ok: true, decisao: "desligada" };
  // Follow-ups ligados (SQL 37): a conversa nunca e encerrada, a IA retoma.
  const retomadas = followupsDoConfig(cfg);
  if (retomadas.length) return await retomarInativas(sb, cfg, retomadas);
  const minutos = minutosEncerramento(cfg);
  if (!minutos) return { ok: true, decisao: "encerramento_desligado" };

  const agora = new Date();
  const ate = new Date(agora.getTime() - minutos * 60000).toISOString();
  const desde = new Date(agora.getTime() - 3 * 24 * 3600 * 1000).toISOString();
  const { data: cards, error } = await sb
    .from("clientes_crm")
    .select("id, numero_whatsapp, telefone, vendedor_id, funil_id")
    .eq("ultima_mensagem_direcao", "enviada")
    .lt("ultima_mensagem_em", ate)
    .gte("ultima_mensagem_em", desde)
    .is("deleted_at", null)
    .order("ultima_mensagem_em", { ascending: true })
    .limit(30);
  if (error) {
    console.error(LOG, "busca de conversas inativas falhou:", error.message);
    return { ok: false, erro: "erro_banco" };
  }

  const horario = dentroDoHorario(agora, cfg.horario_inicio || "08:00", cfg.horario_fim || "19:00", TZ_PADRAO);
  const envioFlag = await icFlag(sb, "envio_whatsapp_cloud_api");
  let encerradas = 0;
  for (const card of (cards as any[]) || []) {
    const para = canonicoTelefone(String(card.numero_whatsapp || card.telefone || ""));
    if (!telefoneBrPlausivel(para)) continue;
    const fase = faseTeste(cfg, para);
    if (!fase.atende) continue;

    const { data: ult } = await sb
      .from("crm_conversas")
      .select("autor, criada_em, payload_raw")
      .eq("cliente_crm_id", card.id)
      .order("criada_em", { ascending: false })
      .limit(1);
    const p = new Pipeline(sb, { cliente_crm_id: String(card.id), conversa_id: null, vendedor_id: card.vendedor_id, funil_id: card.funil_id });
    p.modelo = cfg.modelo || "claude-sonnet-5-5";
  p.cfg = cfg;
    p.card = card;
    p.para = para;
    const decisao = decidirEncerramento({
      ultima: ult && ult.length ? (ult[0] as any) : null,
      agora,
      minutos,
      ultimoEncerramentoEm: await ultimoEncerramento(sb, String(card.id)),
      handoffPendente: await p.temHandoffPendente(),
      dentroDoHorario: horario,
    });
    if (!decisao) continue;
    encerradas++;
    if (decisao === "sem_mensagem") {
      await p.log(ETAPA_ENCERRAMENTO, "encerrada_sem_mensagem", { detalhe: { minutos, dentro_do_horario: horario } });
      continue;
    }
    p.envioLigado = !fase.sombra && envioFlag;
    if (card.vendedor_id) {
      const res = await canalDoVendedor(sb, String(card.vendedor_id));
      if (res.ok) p.canal = res.canal;
    }
    await p.enviar(sortear(TEXTOS_ENCERRAMENTO), ETAPA_ENCERRAMENTO, "encerrada", { minutos }, { encerramento: true });
  }
  if (encerradas) console.log(LOG, "conversas encerradas por inatividade:", encerradas);
  return { ok: true, decisao: "encerramento", encerradas };
}

type ResultadoAgendamento = {
  ok: boolean;
  agendamento_id: string | null;
  inicio: string | null;
  atualizado: boolean;
  erro: string | null;
  sugestoes: string[];
};
const FALHA_AGENDAMENTO: ResultadoAgendamento = { ok: false, agendamento_id: null, inicio: null, atualizado: false, erro: null, sugestoes: [] };

// O lead mandou mensagem depois da que disparou esta invocacao?
async function chegouMensagemNova(sb: SupabaseClient, clienteId: string, gatilhoId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("crm_conversas")
    .select("id")
    .eq("cliente_crm_id", clienteId)
    .eq("direcao", "recebida")
    .order("criada_em", { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return false;
  return String((data[0] as any).id) !== gatilhoId;
}

// Avisa quem confirma os agendamentos (crm_ia_config.aviso_agendamento_whatsapp)
// pelo WhatsApp do numero da clinica. Nao grava em crm_conversas (nao e conversa
// do lead); o resultado fica em ia_decisoes_log. Falha nunca derruba a conversa.
async function avisarEquipeAgendamento(p: Pipeline, cfg: Record<string, string>, input: any, r: ResultadoAgendamento): Promise<void> {
  const numeros = numerosAviso(cfg.aviso_agendamento_whatsapp);
  if (!numeros.length) {
    await p.log("tools", "aviso_equipe_sem_numero");
    return;
  }
  const appUrl = (Deno.env.get("IC_APP_URL") || "").replace(/\/+$/, "");
  const texto = textoAvisoAgendamento({
    nome: String(input.nome_completo || "").trim() || String(p.card?.nome || "").trim(),
    telefone: p.para,
    servico: String(input.servico || "Avaliação"),
    inicioIso: r.inicio || "",
    formato: input.formato === "presencial" ? "Presencial" : input.formato === "online" ? "Online" : null,
    pagamento: String(input.pagamento || "").trim() || null,
    observacao: String(input.observacao || "").trim() || null,
    atualizado: r.atualizado,
    linkCrm: appUrl || null,
  });
  if (!p.envioLigado || !p.canal) {
    await p.log("tools", "aviso_equipe_simulado", { detalhe: { para: numeros.length, texto } });
    return;
  }
  const canal = p.canal;
  await p.comVez(async () => {
    for (const numero of numeros) {
      const env = await enviarTextoCanal(canal, numero, texto, LOG);
      await p.log("tools", env.ok ? "aviso_equipe_enviado" : "aviso_equipe_falhou", {
        detalhe: { agendamento_id: r.agendamento_id, status: env.ok ? null : env.status },
      });
    }
  });
}

// Retoma as conversas em que a IA falou por ultimo e o lead parou de responder
// (_shared/ia-followup.ts). A propria IA escreve a retomada lendo a conversa;
// se ela falhar ou a pos-validacao barrar, vai um texto fixo. Poucas por
// rodada (o varredor roda 1x por minuto) para caber no tempo da funcao.
const RETOMADAS_POR_RODADA = 3;
async function retomarInativas(sb: SupabaseClient, cfg: Record<string, string>, minutos: number[]): Promise<Record<string, unknown>> {
  const agora = new Date();
  if (!podeMandarFollowup(agora, cfg.followup_horario, TZ_PADRAO)) return { ok: true, decisao: "followup_fora_da_janela" };
  const ate = new Date(agora.getTime() - minutos[0] * 60000).toISOString();
  const desde = new Date(agora.getTime() - (minutos[minutos.length - 1] + 3 * 1440) * 60000).toISOString();
  const { data: cards, error } = await sb
    .from("clientes_crm")
    .select("id, nome, numero_whatsapp, telefone, vendedor_id, funil_id, etapa")
    .eq("ultima_mensagem_direcao", "enviada")
    .lt("ultima_mensagem_em", ate)
    .gte("ultima_mensagem_em", desde)
    .is("deleted_at", null)
    .not("etapa", "in", "(fechado,perdido,cliente_antigo)")
    .order("ultima_mensagem_em", { ascending: true })
    .limit(40);
  if (error) {
    console.error(LOG, "busca de conversas paradas falhou:", error.message);
    return { ok: false, erro: "erro_banco" };
  }
  const envioFlag = await icFlag(sb, "envio_whatsapp_cloud_api");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  let enviadas = 0;
  for (const card of (cards as any[]) || []) {
    if (enviadas >= RETOMADAS_POR_RODADA) break;
    const para = canonicoTelefone(String(card.numero_whatsapp || card.telefone || ""));
    if (!telefoneBrPlausivel(para)) continue;
    const fase = faseTeste(cfg, para);
    if (!fase.atende) continue;
    const { data: recentes } = await sb
      .from("crm_conversas")
      .select("autor, criada_em, payload_raw")
      .eq("cliente_crm_id", card.id)
      .order("criada_em", { ascending: false })
      .limit(10);
    const decisao = decidirFollowup({ recentes: (recentes as any[]) || [], agora, minutos });
    if (!decisao) continue;

    const p = new Pipeline(sb, { cliente_crm_id: String(card.id), conversa_id: null, vendedor_id: card.vendedor_id, funil_id: card.funil_id });
    p.modelo = cfg.modelo || "claude-sonnet-5-5";
  p.cfg = cfg;
    p.card = card;
    p.para = para;
    if (await p.temHandoffPendente()) continue;
    // Quem recusou o atendimento (LGPD) nao recebe retomada.
    const { data: cons } = await sb
      .from("ia_consentimentos")
      .select("status")
      .eq("cliente_crm_id", card.id)
      .order("criado_em", { ascending: false })
      .limit(1);
    if (!consentimentoLibera(cfg, cons && cons.length ? String((cons[0] as any).status) : null)) continue;

    p.envioLigado = !fase.sombra && envioFlag;
    if (card.vendedor_id) {
      const res = await canalDoVendedor(sb, String(card.vendedor_id));
      if (res.ok) p.canal = res.canal;
    }
    const texto = await textoDaRetomada(sb, p, cfg, apiKey, decisao.numero, minutos.length, decisao.parado_min);
    enviadas++;
    await p.enviar(texto.texto, "followup", "followup_enviado", { numero: decisao.numero, parado_min: decisao.parado_min, origem: texto.origem }, { followup: true, followup_numero: decisao.numero });
  }
  if (enviadas) console.log(LOG, "retomadas enviadas:", enviadas);
  return { ok: true, decisao: "followup", enviadas };
}

// Lembrete de confirmacao do horario marcado (_shared/confirmacao-agendamento.ts).
// TEMPORARIO: desliga com crm_ia_config.confirmacao_antes_horas vazio. Texto fixo
// (sem chamar o modelo); a resposta da pessoa segue pelo atendimento normal.
// So para quem autorizou o atendimento (LGPD), poucos por rodada.
const CONFIRMACOES_POR_RODADA = 3;
async function lembrarConfirmacoes(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const cfg = await iaConfig(sb);
  const horas = horasConfirmacao(cfg);
  if (!horas) return { ok: true, decisao: "confirmacao_desligada" };
  const horasCurta = horasConfirmacaoCurta(cfg);
  if (!(await icFlag(sb, "ia_pre_atendimento")) || String(cfg.ligada).toLowerCase() !== "true") return { ok: true, decisao: "desligada" };
  const agora = new Date();
  if (!podeMandarFollowup(agora, cfg.followup_horario, TZ_PADRAO)) return { ok: true, decisao: "fora_da_janela" };

  // +24 h no teto: a janela de segunda adianta para sabado.
  const { data: ags, error } = await sb
    .from("agendamentos")
    .select("id, cliente_crm_id, inicio, status, criado_em, telefone_lead")
    .in("status", STATUS_COM_LEMBRETE)
    .not("cliente_crm_id", "is", null)
    .gt("inicio", new Date(agora.getTime() + MINIMO_ANTES_MS).toISOString())
    .lte("inicio", new Date(agora.getTime() + (horas + 24) * 3600 * 1000).toISOString())
    .order("inicio", { ascending: true })
    .limit(30);
  if (error) {
    console.error(LOG, "busca de agendamentos para confirmar falhou:", error.message);
    return { ok: false, erro: "erro_banco" };
  }
  const envioFlag = await icFlag(sb, "envio_whatsapp_cloud_api");
  let enviadas = 0;
  for (const ag of (ags as any[]) || []) {
    if (enviadas >= CONFIRMACOES_POR_RODADA) break;
    const marca = { agendamento_id: String(ag.id), inicio: String(ag.inicio) };
    const { data: logs } = await sb
      .from("ia_decisoes_log")
      .select("decisao, criado_em")
      .eq("cliente_crm_id", ag.cliente_crm_id)
      .eq("etapa_pipeline", ETAPA_CONFIRMACAO)
      .contains("detalhe", marca)
      .limit(20);
    const lista = (logs as any[]) || [];
    const jaFoi = lista.some((l) => l.decisao === "lembrete_enviado" || l.decisao === "simulada_envio_desligado");
    // Rodada anterior ainda enviando (o envio leva o tempo do "digitando..."): nao duplica.
    const emAndamento = lista.some((l) => l.decisao === "tentativa" && agora.getTime() - Date.parse(String(l.criado_em)) < 5 * 60000);
    const tentativas = lista.filter((l) => l.decisao === "tentativa").length;
    if (jaFoi || emAndamento) continue;
    if (!precisaLembrete({ inicio: ag.inicio, criadoEm: ag.criado_em, status: ag.status, agora, horas, horasCurta, tentativas })) continue;

    const { data: cards } = await sb
      .from("clientes_crm")
      .select("id, nome, numero_whatsapp, telefone, vendedor_id, funil_id")
      .eq("id", ag.cliente_crm_id)
      .is("deleted_at", null)
      .limit(1);
    const card = cards && cards.length ? (cards[0] as any) : null;
    if (!card) continue;
    const para = canonicoTelefone(String(card.numero_whatsapp || card.telefone || ag.telefone_lead || ""));
    if (!telefoneBrPlausivel(para)) continue;
    const fase = faseTeste(cfg, para);
    if (!fase.atende) continue;
    const { data: cons } = await sb
      .from("ia_consentimentos")
      .select("status")
      .eq("cliente_crm_id", card.id)
      .order("criado_em", { ascending: false })
      .limit(1);
    if (!consentimentoLibera(cfg, cons && cons.length ? String((cons[0] as any).status) : null)) continue;

    const p = new Pipeline(sb, { cliente_crm_id: String(card.id), conversa_id: null, vendedor_id: card.vendedor_id, funil_id: card.funil_id });
    p.modelo = cfg.modelo || "claude-sonnet-5-5";
    p.cfg = cfg;
    p.card = card;
    p.para = para;
    p.envioLigado = !fase.sombra && envioFlag;
    if (card.vendedor_id) {
      const res = await canalDoVendedor(sb, String(card.vendedor_id));
      if (res.ok) p.canal = res.canal;
    }
    const texto = textoConfirmacao({ primeiroNome: card.nome, inicioIso: String(ag.inicio), agora, variante: Math.floor(Math.random() * 3) });
    enviadas++;
    await p.log(ETAPA_CONFIRMACAO, "tentativa", { detalhe: marca });
    await p.enviar(texto, ETAPA_CONFIRMACAO, "lembrete_enviado", marca, { confirmacao_agendamento: true, agendamento_id: marca.agendamento_id });
  }
  if (enviadas) console.log(LOG, "lembretes de confirmacao enviados:", enviadas);
  return { ok: true, decisao: "confirmacao", enviadas };
}

// A IA escreve a retomada a partir da conversa; texto fixo se nao der.
async function textoDaRetomada(
  sb: SupabaseClient, p: Pipeline, cfg: Record<string, string>, apiKey: string, numero: number, total: number, paradoMin: number,
): Promise<{ texto: string; origem: string }> {
  return await textoComInstrucao(sb, p, cfg, apiKey, instrucaoFollowup(numero, total, paradoMin), "followup", textoFollowupFixo(numero));
}

// A IA le a conversa atual e escreve UMA mensagem seguindo uma instrucao
// interna (que vai como ultima fala, nao e da pessoa). Sem ferramentas; se a IA
// falhar ou a pos-validacao barrar, vai o texto fixo.
async function textoComInstrucao(
  sb: SupabaseClient, p: Pipeline, cfg: Record<string, string>, apiKey: string, instrucao: string, etapaLog: string, textoFixo: string,
): Promise<{ texto: string; origem: string }> {
  const fixo = { texto: textoFixo, origem: "fixo" };
  if (!apiKey) return fixo;
  const { data: ctxRaw, error } = await sb.rpc("ic_ia_contexto", { p_cliente: p.body.cliente_crm_id, p_limite: limiteContexto(cfg) });
  if (error || !ctxRaw) return fixo;
  const ctx = ctxRaw as Contexto;
  ctx.mensagens = mensagensDaConversaAtual(Array.isArray(ctx.mensagens) ? ctx.mensagens : [], await ultimoEncerramento(sb, p.body.cliente_crm_id));
  const historico = mensagensParaClaude({ ...ctx, mensagens: [...ctx.mensagens, { autor: "lead", exibicao: instrucao, criada_em: new Date().toISOString() }] });
  if (!historico.length) return fixo;
  const agoraSp = partesNoFuso(new Date(), TZ_PADRAO);
  const nomesDia = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const system = montarSystemPrompt({
    primeiroNome: ctx.primeiro_nome ? String(ctx.primeiro_nome).split(/\s+/)[0] : null,
    funil: ctx.funil,
    etapa: ctx.etapa_label,
    exemplos: [],
    agoraLocal: `${nomesDia[agoraSp.diaSemana]}, ${String(agoraSp.dia).padStart(2, "0")}/${String(agoraSp.mes).padStart(2, "0")}/${agoraSp.ano} ${String(agoraSp.hora).padStart(2, "0")}:${String(agoraSp.minuto).padStart(2, "0")}`,
    calendario: calendarioDiasUteis(agoraSp.ano, agoraSp.mes, agoraSp.dia),
    persona: { nome: cfg.persona_nome, ficha: cfg.persona_ficha },
  });
  const r = await chamarClaude({ apiKey, modelo: p.modelo, maxTokens: Math.max(256, Number(cfg.max_tokens || "1024") || 1024), system, messages: historico });
  await p.log(etapaLog, r.erro ? "erro_ia" : "ia_escreveu", {
    modelo: p.modelo, tokens_entrada: r.tokens_entrada, tokens_saida: r.tokens_saida, latencia_ms: r.latencia_ms, motivo: r.erro,
  });
  const texto = paraWhatsApp(r.texto || "");
  if (r.erro || !texto || r.tools.length) return fixo;
  const proibido = respostaProibida(texto);
  if (proibido) {
    await p.log(etapaLog, "bloqueada_pos_validacao", { motivo: proibido, detalhe: { resposta: texto } });
    return fixo;
  }
  return { texto, origem: "ia" };
}

// ---------------------------------------------------------------------------
// Retomada depois de queda do WhatsApp (_shared/retomada-queda.ts, SQL 41).
// O varredor (1x por minuto) olha a conexao de cada numero Z-API e marca a
// queda em ic_whatsapp_quedas. Ao reconectar, le na Z-API quem mandou mensagem
// durante a queda (o texto nao vem) e poe na fila ic_retomada_queda. A fila
// anda UMA pessoa por vez, a cada retomada_queda_intervalo_min, dentro do
// horario: a Jully pede desculpas pela demora e pede para mandar de novo.
// ---------------------------------------------------------------------------
const PAGINAS_CHATS = 4;
const CHATS_POR_PAGINA = 50;
// Retomada que ficou "processando" alem disso caiu no meio (a funcao parou).
const PRAZO_PROCESSANDO_MS = 10 * 60_000;

async function retomarAposQueda(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const cfg = await iaConfig(sb);
  const rq = configRetomadaQueda(cfg);
  if (!rq.ligada) return { ok: true, decisao: "retomada_queda_desligada" };
  if (!(await icFlag(sb, "ia_pre_atendimento")) || String(cfg.ligada).toLowerCase() !== "true") return { ok: true, decisao: "desligada" };

  const { data: linhas, error } = await sb.from("vendedores_whatsapp").select("*").eq("ativo", true);
  if (error) {
    console.error(LOG, "retomada pos-queda: vendedores_whatsapp falhou:", error.message);
    return { ok: false, erro: "erro_banco" };
  }
  const todas = (linhas as any[]) || [];
  // Os numeros do proprio CRM e os da equipe nunca entram na fila.
  const ignorar = [...todas.map((l) => String(l.numero_whatsapp || "")), ...numerosAviso(cfg.aviso_agendamento_whatsapp)];
  const agora = new Date();
  const conexao: Record<string, unknown>[] = [];
  for (const linha of todas) {
    if (provedorDaLinha(linha) !== "zapi" || !linha.zapi_instancia) continue;
    const c = canalDaLinha(linha, (n) => Deno.env.get(n));
    if (!c.ok || c.canal.provedor !== "zapi") continue;
    conexao.push(await vigiarConexao(sb, cfg, rq, linha, c.canal, ignorar, agora));
  }
  const fila = await processarFilaQueda(sb, cfg, rq, agora);
  return { ok: true, conexao, fila };
}

// Abre a queda quando cai, fecha quando volta e, depois de fechar, coleta quem
// escreveu nesse periodo (tenta de novo a cada minuto ate PRAZO_COLETA_MS).
async function vigiarConexao(
  sb: SupabaseClient, cfg: Record<string, string>, rq: ConfigRetomadaQueda, linha: any, canal: CanalZapi, ignorar: string[], agora: Date,
): Promise<Record<string, unknown>> {
  const linhaId = String(linha.id);
  const s = await statusZapi(canal, LOG);
  if (!s.ok) return { linha: linhaId, decisao: "status_indisponivel" };
  const { data: abertas, error } = await sb
    .from("ic_whatsapp_quedas")
    .select("id")
    .eq("linha_id", linhaId)
    .is("reconectado_em", null)
    .limit(1);
  if (error) {
    console.error(LOG, "ic_whatsapp_quedas falhou (SQL 41 aplicado?):", error.message);
    return { linha: linhaId, decisao: "erro_banco" };
  }
  const aberta = abertas && abertas.length ? String((abertas[0] as any).id) : null;
  if (!s.conectado) {
    if (aberta) return { linha: linhaId, decisao: "desconectado" };
    const { error: errIns } = await sb.from("ic_whatsapp_quedas").insert({
      linha_id: linhaId,
      desconectado_em: new Date(agora.getTime() - FOLGA_DESCONEXAO_MS).toISOString(),
    });
    // 23505: outra rodada abriu ao mesmo tempo (indice unico da queda aberta).
    if (errIns && errIns.code !== "23505") console.error(LOG, "abrir queda falhou:", errIns.message);
    else console.warn(LOG, "WhatsApp desconectado, queda registrada:", linhaId);
    return { linha: linhaId, decisao: "queda_registrada" };
  }
  if (aberta) {
    const { error: errUpd } = await sb
      .from("ic_whatsapp_quedas")
      .update({ reconectado_em: agora.toISOString() })
      .eq("id", aberta)
      .is("reconectado_em", null);
    if (errUpd) console.error(LOG, "fechar queda falhou:", errUpd.message);
    else console.log(LOG, "WhatsApp reconectado:", linhaId);
  }
  const { data: aColetar } = await sb
    .from("ic_whatsapp_quedas")
    .select("id, desconectado_em, reconectado_em")
    .eq("linha_id", linhaId)
    .not("reconectado_em", "is", null)
    .is("conversas", null)
    .gte("reconectado_em", new Date(agora.getTime() - PRAZO_COLETA_MS).toISOString())
    .order("desconectado_em", { ascending: true })
    .limit(3);
  let enfileiradas = 0;
  for (const q of (aColetar as any[]) || []) {
    const n = await coletarConversasDaQueda(sb, cfg, rq, linha, canal, q, ignorar, agora);
    if (n != null) enfileiradas += n;
  }
  return { linha: linhaId, decisao: "conectado", enfileiradas };
}

// null = a Z-API nao respondeu a lista (tenta na proxima rodada).
async function coletarConversasDaQueda(
  sb: SupabaseClient, cfg: Record<string, string>, rq: ConfigRetomadaQueda, linha: any, canal: CanalZapi, queda: any, ignorar: string[], agora: Date,
): Promise<number | null> {
  const chats: ChatZapi[] = [];
  for (let pagina = 1; pagina <= PAGINAS_CHATS; pagina++) {
    const r = await chatsZapi(canal, pagina, CHATS_POR_PAGINA, LOG);
    if (!r.ok) {
      if (pagina === 1) {
        console.warn(LOG, "lista de conversas da Z-API indisponivel:", r.detalhe);
        return null;
      }
      break;
    }
    chats.push(...r.chats);
    if (r.chats.length < CHATS_POR_PAGINA) break;
  }
  const candidatos = selecionarChatsDaQueda(chats, {
    desconectadoEm: Date.parse(String(queda.desconectado_em)),
    ate: agora.getTime(),
    ignorar,
  });
  const fila: Record<string, unknown>[] = [];
  for (const c of candidatos) {
    if (!faseTeste(cfg, c.telefone).atende) continue;
    const card = await cardPorTelefone(sb, linha.vendedor_id ? String(linha.vendedor_id) : null, c.telefone);
    if (card) {
      if (jaNoCrm(await ultimaMensagemNoCrm(sb, String(card.id)), c.ultimaEm)) continue;
    } else if (!rq.desconhecidos) continue;
    fila.push({
      queda_id: queda.id,
      linha_id: linha.id,
      telefone: c.telefone,
      nome: c.nome || null,
      ultima_msg_em: new Date(c.ultimaEm).toISOString(),
      cliente_crm_id: card ? card.id : null,
    });
  }
  if (fila.length) {
    const { error } = await sb.from("ic_retomada_queda").upsert(fila, { onConflict: "queda_id,telefone", ignoreDuplicates: true });
    if (error) {
      console.error(LOG, "ic_retomada_queda recusou:", error.message);
      return null;
    }
  }
  const { error: errUpd } = await sb.from("ic_whatsapp_quedas").update({ conversas: fila.length }).eq("id", queda.id);
  if (errUpd) console.error(LOG, "registrar conversas da queda falhou:", errUpd.message);
  console.log(LOG, "queda", queda.id, "conversas na Z-API:", chats.length, "na fila:", fila.length);
  return fila.length;
}

// Mesmo caminho do webhook: card do vendedor com o numero em qualquer variacao.
async function cardPorTelefone(sb: SupabaseClient, vendedorId: string | null, telefone: string): Promise<any | null> {
  if (!vendedorId) return null;
  const { data } = await sb
    .from("clientes_crm")
    .select("id, nome, numero_whatsapp, telefone, vendedor_id, funil_id")
    .eq("vendedor_id", vendedorId)
    .in("numero_whatsapp", variacoesTelefone(telefone))
    .is("deleted_at", null)
    .is("mesclado_para", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data && data.length ? data[0] : null;
}

async function ultimaMensagemNoCrm(sb: SupabaseClient, clienteId: string): Promise<number | null> {
  const { data } = await sb
    .from("crm_conversas")
    .select("criada_em")
    .eq("cliente_crm_id", clienteId)
    .order("criada_em", { ascending: false })
    .limit(1);
  const t = data && data.length ? Date.parse(String((data[0] as any).criada_em)) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Uma retomada por rodada, respeitando o intervalo e o horario.
async function processarFilaQueda(sb: SupabaseClient, cfg: Record<string, string>, rq: ConfigRetomadaQueda, agora: Date): Promise<Record<string, unknown>> {
  // Rede de seguranca: a que ficou presa em "processando" vira falha.
  await sb
    .from("ic_retomada_queda")
    .update({ estado: "falhou", motivo: "interrompida" })
    .eq("estado", "processando")
    .lt("processada_em", new Date(agora.getTime() - PRAZO_PROCESSANDO_MS).toISOString());
  if (!podeMandarFollowup(agora, rq.horario, TZ_PADRAO)) return { decisao: "fora_da_janela" };
  const { data: ult, error } = await sb
    .from("ic_retomada_queda")
    .select("processada_em")
    .in("estado", ["processando", "enviada", "falhou"])
    .not("processada_em", "is", null)
    .order("processada_em", { ascending: false })
    .limit(1);
  if (error) return { decisao: "erro_banco" };
  const ultMs = ult && ult.length ? Date.parse(String((ult[0] as any).processada_em)) : null;
  if (!podeRetomarAgora(Number.isFinite(ultMs) ? ultMs : null, agora.getTime(), rq.intervaloMin)) return { decisao: "aguardando_intervalo" };

  const { data: pendentes } = await sb
    .from("ic_retomada_queda")
    .select("*")
    .eq("estado", "pendente")
    .order("ultima_msg_em", { ascending: true })
    .limit(10);
  for (const item of (pendentes as any[]) || []) {
    const marcar = (estado: string, motivo: string | null) =>
      sb.from("ic_retomada_queda").update({ estado, motivo, processada_em: new Date().toISOString() }).eq("id", item.id);
    if (retomadaVencida(Date.parse(String(item.ultima_msg_em)), agora.getTime())) {
      await marcar("ignorada", "vencida");
      continue;
    }
    // Reserva o item: so uma rodada o processa.
    const { data: reservado } = await sb
      .from("ic_retomada_queda")
      .update({ estado: "processando", processada_em: new Date().toISOString() })
      .eq("id", item.id)
      .eq("estado", "pendente")
      .select("id");
    if (!reservado || !reservado.length) continue;
    const r = await retomarUma(sb, cfg, rq, item);
    await marcar(r.estado, r.motivo);
    // Ignorada nao gasta a vez: tenta a proxima da fila na mesma rodada.
    if (r.estado !== "ignorada") return { decisao: r.estado, motivo: r.motivo };
  }
  return { decisao: "fila_vazia" };
}

// Le na Z-API as mensagens que a pessoa mandou durante a queda e entrega cada
// uma ao ic-meta-webhook (porta da Z-API), como se tivessem chegado agora.
// Devolve quantas o webhook aceitou (0 = nao deu para ler; segue o pedido de reenvio).
async function reprocessarMensagensDaQueda(sb: SupabaseClient, linha: any, canal: CanalEnvio, tel: string, item: any): Promise<number> {
  if (canal.provedor !== "zapi") return 0;
  const URL_SB = Deno.env.get("SUPABASE_URL") || "";
  const segredo = Deno.env.get("ZAPI_WEBHOOK_TOKEN") || "";
  if (!URL_SB || !segredo) {
    console.warn(LOG, "retomada pos-queda: ZAPI_WEBHOOK_TOKEN ausente, nao reprocessa");
    return 0;
  }
  const { data: queda } = await sb.from("ic_whatsapp_quedas").select("desconectado_em").eq("id", item.queda_id).maybeSingle();
  const desde = queda ? Date.parse(String((queda as any).desconectado_em)) : Date.parse(String(item.ultima_msg_em)) - 3600_000;
  const r = await mensagensChatZapi(canal, tel, 20, LOG);
  if (!r.ok) {
    console.warn(LOG, "retomada pos-queda: mensagens da conversa indisponiveis na Z-API:", r.detalhe);
    return 0;
  }
  let msgs = mensagensDaQueda(r.mensagens, { desdeMs: desde - MARGEM_CASAMENTO_MS, ateMs: Date.now() });
  if (!msgs.length) return 0;
  // As que ja estao no CRM (chegaram antes da queda ou depois de reconectar) ficam de fora.
  const { data: jaTem } = await sb
    .from("crm_conversas")
    .select("zapi_message_id")
    .in("zapi_message_id", msgs.map((m) => String(m.messageId)));
  const ids = new Set(((jaTem as any[]) || []).map((x) => String(x.zapi_message_id)));
  msgs = msgs.filter((m) => !ids.has(String(m.messageId)));
  let aceitas = 0;
  for (const m of msgs) {
    const evento = eventoParaReprocessar(m, {
      instancia: String(linha.zapi_instancia || ""),
      numero: soDigitos(String(linha.numero_whatsapp || "")),
      telefoneLead: tel,
    });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const resp = await fetch(`${URL_SB}/functions/v1/ic-meta-webhook?provedor=zapi&token=${encodeURIComponent(segredo)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(evento),
        signal: ctl.signal,
      });
      const d: any = await resp.json().catch(() => ({}));
      if (resp.ok && d && d.ack === true) aceitas++;
      else console.warn(LOG, "retomada pos-queda: webhook nao aceitou a mensagem:", resp.status, d && (d.ignored || d.error));
    } catch (e) {
      console.error(LOG, "retomada pos-queda: webhook sem resposta:", e instanceof Error ? e.message : e);
    } finally {
      clearTimeout(t);
    }
  }
  return aceitas;
}

async function retomarUma(
  sb: SupabaseClient, cfg: Record<string, string>, rq: ConfigRetomadaQueda, item: any,
): Promise<{ estado: "enviada" | "ignorada" | "falhou"; motivo: string | null }> {
  const tel = canonicoTelefone(String(item.telefone || ""));
  if (!telefoneBrPlausivel(tel)) return { estado: "ignorada", motivo: "telefone_invalido" };
  const fase = faseTeste(cfg, tel);
  if (!fase.atende) return { estado: "ignorada", motivo: "fora_dos_numeros_teste" };
  const { data: linha } = await sb.from("vendedores_whatsapp").select("*").eq("id", item.linha_id).maybeSingle();
  const c = linha ? canalDaLinha(linha, (n) => Deno.env.get(n)) : null;
  if (!c || !c.ok) return { estado: "falhou", motivo: "sem_canal" };
  const envioLigado = !fase.sombra && (await icFlag(sb, "envio_whatsapp_cloud_api"));
  const ultimaMsgMs = Date.parse(String(item.ultima_msg_em));

  // A pessoa pode ter escrito de novo depois de reconectar (e ganhado card).
  let card: any = null;
  if (item.cliente_crm_id) {
    const { data } = await sb
      .from("clientes_crm")
      .select("id, nome, numero_whatsapp, telefone, vendedor_id, funil_id, deleted_at")
      .eq("id", item.cliente_crm_id)
      .maybeSingle();
    card = data && !(data as any).deleted_at ? data : null;
  }
  if (!card) card = await cardPorTelefone(sb, (linha as any).vendedor_id ? String((linha as any).vendedor_id) : null, tel);
  if (card && jaNoCrm(await ultimaMensagemNoCrm(sb, String(card.id)), ultimaMsgMs)) return { estado: "ignorada", motivo: "ja_atendida" };

  // Primeiro tenta ler o que a pessoa escreveu e reprocessar pelo webhook: a
  // Jully responde no mesmo contexto, pelo caminho normal (rajada, regras, vez).
  const recuperadas = await reprocessarMensagensDaQueda(sb, linha, c.canal, tel, item);
  if (recuperadas > 0) {
    console.log(LOG, "retomada pos-queda: mensagens recuperadas e reprocessadas:", recuperadas);
    return { estado: "enviada", motivo: `mensagens_recuperadas:${recuperadas}` };
  }

  // Sem conseguir ler: pede com naturalidade que a pessoa mande de novo.
  if (card) {
    const p = new Pipeline(sb, { cliente_crm_id: String(card.id), conversa_id: null, vendedor_id: card.vendedor_id, funil_id: card.funil_id });
    p.modelo = cfg.modelo || "claude-sonnet-5-5";
    p.cfg = cfg;
    p.card = card;
    p.para = tel;
    if (await p.temHandoffPendente()) return { estado: "ignorada", motivo: "handoff_pendente" };
    const { data: cons } = await sb
      .from("ia_consentimentos")
      .select("status")
      .eq("cliente_crm_id", card.id)
      .order("criado_em", { ascending: false })
      .limit(1);
    if (!consentimentoLibera(cfg, cons && cons.length ? String((cons[0] as any).status) : null)) return { estado: "ignorada", motivo: "consentimento" };
    p.envioLigado = envioLigado;
    p.canal = c.canal;
    const minutosDesde = Math.max(1, Math.round((Date.now() - ultimaMsgMs) / 60000));
    const texto = await textoComInstrucao(
      sb, p, cfg, Deno.env.get("ANTHROPIC_API_KEY") || "", instrucaoRetomadaQueda(minutosDesde), ETAPA_RETOMADA_QUEDA, textoRetomadaQuedaFixo(true),
    );
    const env = await p.enviarEmPartes(texto.texto, ETAPA_RETOMADA_QUEDA, "retomada_enviada", { origem: texto.origem, queda_id: item.queda_id }, { retomada_queda: true });
    if (env.enviado) return { estado: "enviada", motivo: null };
    return envioLigado ? { estado: "falhou", motivo: "envio_falhou" } : { estado: "enviada", motivo: "simulada" };
  }

  if (!rq.desconhecidos) return { estado: "ignorada", motivo: "sem_card" };
  // Sem card: texto fixo (nao ha conversa para a IA ler). O card nasce quando a
  // pessoa responder, pelo caminho normal do webhook.
  const texto = textoRetomadaQuedaFixo(false);
  // Sem card o log fica sem cliente_crm_id (coluna aceita nulo).
  const p = new Pipeline(sb, { cliente_crm_id: null as unknown as string, conversa_id: null, vendedor_id: (linha as any).vendedor_id, funil_id: null });
  p.cfg = cfg;
  if (!envioLigado) {
    await p.log(ETAPA_RETOMADA_QUEDA, "simulada_envio_desligado", { detalhe: { resposta: texto, sem_card: true, retomada_id: item.id } });
    return { estado: "enviada", motivo: "simulada" };
  }
  const canal = c.canal;
  const caixa: { ok: boolean } = { ok: false };
  const teveVez = await p.comVez(async () => {
    const t0 = Date.now();
    const r = await enviarTextoCanal(canal, tel, texto, LOG, { simularDigitacao: true });
    caixa.ok = r.ok;
    if (r.ok && canal.provedor === "zapi") {
      const falta = segundosDigitando(texto) * 1000 + 1000 - (Date.now() - t0);
      if (falta > 0) await new Promise((res) => setTimeout(res, falta));
    }
  });
  await p.log(ETAPA_RETOMADA_QUEDA, caixa.ok ? "retomada_enviada" : "erro_envio", {
    resposta_enviada: caixa.ok,
    detalhe: { sem_card: true, retomada_id: item.id, sem_vez: !teveVez },
  });
  if (!teveVez) return { estado: "falhou", motivo: "sem_vez" };
  return caixa.ok ? { estado: "enviada", motivo: null } : { estado: "falhou", motivo: "envio_falhou" };
}

// Chama ic-agendamento internamente (acao 'propor'): reserva o horario (status
// pendente; a equipe confirma com o lead). Horario tomado volta com sugestoes.
async function proporAgendamento(
  clienteId: string,
  input: any,
): Promise<ResultadoAgendamento> {
  try {
    const URL_SB = Deno.env.get("SUPABASE_URL") || "";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const resp = await fetch(`${URL_SB}/functions/v1/ic-agendamento`, {
      method: "POST",
      headers: headersInternos(),
      body: JSON.stringify({
        acao: "propor",
        cliente_crm_id: clienteId,
        dia_preferido: String(input.dia_preferido || ""),
        periodo: input.periodo === "tarde" ? "tarde" : "manha",
        horario_preferido: String(input.horario_preferido || "").slice(0, 10),
        servico: String(input.servico || "Avaliação").slice(0, 120),
        observacao: String(input.observacao || "").slice(0, 300),
        nome_completo: String(input.nome_completo || "").slice(0, 120),
        formato: input.formato === "presencial" ? "Presencial" : input.formato === "online" ? "Online" : "",
        pagamento: String(input.pagamento || "").slice(0, 120),
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const data: any = await resp.json().catch(() => ({}));
    const sugestoes = Array.isArray(data?.sugestoes) ? data.sugestoes.map(String).slice(0, 3) : [];
    if (!resp.ok || !data || data.ok === false) {
      if (data?.erro !== "horario_ocupado") console.error(LOG, "ic-agendamento propor falhou:", resp.status, JSON.stringify(data).slice(0, 200));
      return { ...FALHA_AGENDAMENTO, erro: data && data.erro ? String(data.erro) : `http_${resp.status}`, sugestoes };
    }
    return {
      ok: true,
      agendamento_id: data.agendamento_id ? String(data.agendamento_id) : null,
      inicio: data.inicio ? String(data.inicio) : null,
      atualizado: data.atualizado === true,
      erro: null,
      sugestoes: [],
    };
  } catch (e) {
    console.error(LOG, "ic-agendamento propor excecao:", e instanceof Error ? e.message : e);
    return { ...FALHA_AGENDAMENTO, erro: "excecao" };
  }
}

// Texto fixo das regras por codigo (CFM): urgencia e duvida clinica nao passam
// pela IA. Reclamacao e pedido de humano devolvem null (a IA conduz).
function textoFixoRegra(motivo: string): string | null {
  if (motivo === "urgencia") return RESPOSTA_URGENCIA;
  if (motivo === "duvida_clinica") return sortear(TEXTOS_RESPOSTA_BLOQUEADA);
  return null;
}

// Cancelamento pedido pelo lead: ic-agendamento {acao:'cancelar'} (porta interna).
type ResultadoCancelamento = { ok: boolean; agendamento_id: string | null; inicio: string | null; titulo: string; erro: string | null };
async function cancelarAgendamentoDoLead(clienteId: string, motivo: string): Promise<ResultadoCancelamento> {
  const falha = (erro: string): ResultadoCancelamento => ({ ok: false, agendamento_id: null, inicio: null, titulo: "", erro });
  try {
    const URL_SB = Deno.env.get("SUPABASE_URL") || "";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const resp = await fetch(`${URL_SB}/functions/v1/ic-agendamento`, {
      method: "POST",
      headers: headersInternos(),
      body: JSON.stringify({ acao: "cancelar", cliente_crm_id: clienteId, motivo }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      if (data?.erro !== "sem_agendamento") console.error(LOG, "ic-agendamento cancelar falhou:", resp.status, JSON.stringify(data).slice(0, 200));
      return falha(data && data.erro ? String(data.erro) : `http_${resp.status}`);
    }
    return {
      ok: true,
      agendamento_id: data.agendamento_id ? String(data.agendamento_id) : null,
      inicio: data.inicio ? String(data.inicio) : null,
      titulo: String(data.titulo || ""),
      erro: null,
    };
  } catch (e) {
    console.error(LOG, "ic-agendamento cancelar excecao:", e instanceof Error ? e.message : e);
    return falha("excecao");
  }
}

// Confirmacao de presenca pelo lead: ic-agendamento {acao:'confirmar'} (porta interna).
// Falha aqui nao muda a resposta: o agradecimento continua valendo, so o status fica pendente.
type ResultadoConfirmacao = { ok: boolean; agendamento_id: string | null; inicio: string | null; ja_confirmado: boolean; erro: string | null };
async function confirmarAgendamentoDoLead(clienteId: string): Promise<ResultadoConfirmacao> {
  const falha = (erro: string): ResultadoConfirmacao => ({ ok: false, agendamento_id: null, inicio: null, ja_confirmado: false, erro });
  try {
    const URL_SB = Deno.env.get("SUPABASE_URL") || "";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const resp = await fetch(`${URL_SB}/functions/v1/ic-agendamento`, {
      method: "POST",
      headers: headersInternos(),
      body: JSON.stringify({ acao: "confirmar", cliente_crm_id: clienteId }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      if (data?.erro !== "sem_agendamento") console.error(LOG, "ic-agendamento confirmar falhou:", resp.status, JSON.stringify(data).slice(0, 200));
      return falha(data && data.erro ? String(data.erro) : `http_${resp.status}`);
    }
    return {
      ok: true,
      agendamento_id: data.agendamento_id ? String(data.agendamento_id) : null,
      inicio: data.inicio ? String(data.inicio) : null,
      ja_confirmado: data.ja_confirmado === true,
      erro: null,
    };
  } catch (e) {
    console.error(LOG, "ic-agendamento confirmar excecao:", e instanceof Error ? e.message : e);
    return falha("excecao");
  }
}

// Avisa no WhatsApp de quem confirma os agendamentos (mesmos numeros do aviso de agendamento).
async function avisarEquipeCancelamento(p: Pipeline, cfg: Record<string, string>, r: ResultadoCancelamento, motivo: string): Promise<void> {
  const numeros = numerosAviso(cfg.aviso_agendamento_whatsapp);
  if (!numeros.length) {
    await p.log("tools", "aviso_equipe_sem_numero");
    return;
  }
  const appUrl = (Deno.env.get("IC_APP_URL") || "").replace(/\/+$/, "");
  const texto = textoAvisoCancelamento({
    nome: String(p.card?.nome || "").trim(),
    telefone: p.para,
    titulo: r.titulo,
    inicioIso: r.inicio || "",
    motivo: motivo || null,
    linkCrm: appUrl || null,
  });
  if (!p.envioLigado || !p.canal) {
    await p.log("tools", "aviso_cancelamento_simulado", { detalhe: { para: numeros.length, texto } });
    return;
  }
  const canal = p.canal;
  await p.comVez(async () => {
    for (const numero of numeros) {
      const env = await enviarTextoCanal(canal, numero, texto, LOG);
      await p.log("tools", env.ok ? "aviso_cancelamento_enviado" : "aviso_cancelamento_falhou", {
        detalhe: { agendamento_id: r.agendamento_id, status: env.ok ? null : env.status },
      });
    }
  });
}

// Botao "Encerrar conversa" (painel do lead e card completo), chamado pelo FRONT
// com o JWT do usuario. Encerra via RPC ic_encerrar_conversa COMO o usuario
// (o banco confere usuario ativo e card no escopo, SQL 32) e, se a IA estiver
// atendendo esse numero e o lead tiver escrito nas ultimas 24 h, manda a
// despedida TEXTOS_ENCERRAMENTO pelo numero do vendedor.
async function encerrarPelaEquipe(req: Request, sb: SupabaseClient, body: any): Promise<Response> {
  const auth = await usuarioAtivo(req, sb);
  if (!auth.ok) return json({ ok: false, erro: auth.erro }, auth.status);
  const clienteId = String(body.cliente_crm_id || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(clienteId)) return json({ ok: false, erro: "payload_invalido" }, 400);

  const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!ANON) {
    console.error(LOG, "SUPABASE_ANON_KEY ausente");
    return json({ ok: false, erro: "erro_interno" }, 500);
  }
  // Ja encerrada e o lead nao escreveu depois: nao encerra de novo nem manda
  // outra despedida (clique duplo no botao).
  const { data: ultRecebida } = await sb
    .from("crm_conversas")
    .select("criada_em")
    .eq("cliente_crm_id", clienteId)
    .eq("direcao", "recebida")
    .order("criada_em", { ascending: false })
    .limit(1);
  const ultimaDoLead = ultRecebida && ultRecebida.length ? String((ultRecebida[0] as any).criada_em) : null;
  if (jaEncerrada(await ultimoEncerramento(sb, clienteId), ultimaDoLead)) {
    return json({ ok: true, encerrada: true, ja_encerrada: true, mensagem_enviada: false, motivo: "ja_encerrada" });
  }

  const sbUsuario = createClient(Deno.env.get("SUPABASE_URL") || "", ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${tokenDoHeader(req)}` } },
  });
  const { error: errRpc } = await sbUsuario.rpc("ic_encerrar_conversa", { p_cliente: clienteId });
  if (errRpc) {
    const m = String(errRpc.message || "");
    if (m.includes("nao_autorizado") || m.includes("card_nao_encontrado")) return json({ ok: false, erro: "sem_permissao" }, 403);
    console.error(LOG, "ic_encerrar_conversa falhou:", m);
    return json({ ok: false, erro: "erro_banco" }, 500);
  }

  // Despedida: so se a IA esta ligada e atende esse numero, e o lead falou nas ultimas 24 h.
  const semMensagem = (motivo: string) => json({ ok: true, encerrada: true, mensagem_enviada: false, motivo });
  const flagIa = await icFlag(sb, "ia_pre_atendimento");
  const cfg = await iaConfig(sb);
  if (!flagIa || String(cfg.ligada).toLowerCase() !== "true") return semMensagem("ia_desligada");
  const { data: card } = await sb
    .from("clientes_crm")
    .select("id, numero_whatsapp, telefone, vendedor_id, funil_id")
    .eq("id", clienteId)
    .maybeSingle();
  if (!card) return semMensagem("card_nao_encontrado");
  const para = canonicoTelefone(String((card as any).numero_whatsapp || (card as any).telefone || ""));
  if (!telefoneBrPlausivel(para)) return semMensagem("telefone_invalido");
  const fase = faseTeste(cfg, para);
  if (!fase.atende) return semMensagem("fora_dos_numeros_teste");
  const { data: ultLead } = await sb
    .from("crm_conversas")
    .select("criada_em")
    .eq("cliente_crm_id", clienteId)
    .eq("direcao", "recebida")
    .gt("criada_em", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .limit(1);
  if (!ultLead || !ultLead.length) return semMensagem("lead_sem_mensagem_24h");

  const p = new Pipeline(sb, { cliente_crm_id: clienteId, conversa_id: null, vendedor_id: (card as any).vendedor_id, funil_id: (card as any).funil_id });
  p.modelo = cfg.modelo || "claude-sonnet-5-5";
  p.cfg = cfg;
  p.card = card;
  p.para = para;
  p.envioLigado = !fase.sombra && (await icFlag(sb, "envio_whatsapp_cloud_api"));
  if ((card as any).vendedor_id) {
    const res = await canalDoVendedor(sb, String((card as any).vendedor_id));
    if (res.ok) p.canal = res.canal;
  }
  const env = await p.enviar(sortear(TEXTOS_ENCERRAMENTO), ETAPA_ENCERRAMENTO, "encerrada_pela_equipe_com_mensagem",
    { por: auth.usuario.name || auth.usuario.email }, { encerramento: true });
  return json({ ok: true, encerrada: true, mensagem_enviada: env.enviado, motivo: env.enviado ? null : "envio_falhou_ou_desligado" });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo_nao_suportado" }, 405);

  try {
    const URL_SB = Deno.env.get("SUPABASE_URL") || "";
    const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!URL_SB || !SR) {
      console.error(LOG, "SUPABASE_URL/SERVICE_ROLE ausentes");
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "payload_invalido" }, 400);
    }
    const sb = createClient(URL_SB, SR, { auth: { persistSession: false } });
    // Unica acao do FRONT (JWT do usuario); todo o resto exige x-ic-internal.
    if (body.acao === "encerrar_conversa_equipe") return await encerrarPelaEquipe(req, sb, body);
    if (!chamadaInternaValida(req)) return json({ ok: false, erro: "nao_autorizado" }, 401);
    if (body.acao === "encerrar_inativas") {
      const r = await encerrarInativas(sb);
      // Lembrete de confirmacao (temporario; desliga com confirmacao_antes_horas vazio).
      const confirmacoes = await lembrarConfirmacoes(sb).catch((e) => {
        console.error(LOG, "lembretes de confirmacao falharam:", e instanceof Error ? e.message : e);
        return { ok: false, erro: "excecao" };
      });
      // Retomada de quem escreveu enquanto o WhatsApp estava desconectado (SQL 41).
      const retomada_queda = await retomarAposQueda(sb).catch((e) => {
        console.error(LOG, "retomada pos-queda falhou:", e instanceof Error ? e.message : e);
        return { ok: false, erro: "excecao" };
      });
      return json({ ...r, confirmacoes, retomada_queda });
    }

    const clienteId = String(body.cliente_crm_id || "").trim();
    if (!clienteId) return json({ ok: false, erro: "payload_invalido" }, 400);

    const inicio = Date.now();
    const resultado = await rodar(sb, {
      cliente_crm_id: clienteId,
      conversa_id: body.conversa_id ? String(body.conversa_id) : null,
      vendedor_id: body.vendedor_id ? String(body.vendedor_id) : null,
      funil_id: body.funil_id ? String(body.funil_id) : null,
    });
    console.log(LOG, "card", clienteId, "->", resultado.decisao || resultado.erro, `(${Date.now() - inicio} ms)`);
    return json({ ...resultado, duracao_ms: Date.now() - inicio });
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});
