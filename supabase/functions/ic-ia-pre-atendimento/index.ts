// ic-ia-pre-atendimento: IA de pre-atendimento do Instituto Castro no WhatsApp.
//
// Quem chama: SOMENTE o ic-meta-webhook (segundo plano), com header
// x-ic-internal = IC_INTERNAL_SECRET, body {cliente_crm_id, conversa_id,
// vendedor_id, funil_id}. Nunca o front.
// Publicar: supabase functions deploy ic-ia-pre-atendimento --no-verify-jwt
//
// PIPELINE (cada etapa grava uma linha em ia_decisoes_log com etapa_pipeline e decisao):
//   1  flags            ic_flag('ia_pre_atendimento') e crm_ia_config.ligada='true'
//   2  humano_assumiu   vendedor respondeu nas ultimas 24 h, ou ia_handoffs pendente -> fim
//   3  limites          horario (America/Sao_Paulo; fora do horario: 1 aviso/dia/card),
//                       max_respostas_por_conversa (atingiu: handoff 'manual')
//   4  contexto         RPC ic_ia_contexto(card, 12)
//   5  consentimento    LGPD: pede, interpreta SIM/NAO, nega -> handoff + despedida
//   6  handoff_regras   regex por CODIGO (urgencia, duvida clinica, reclamacao, humano)
//   7  exemplos         ate 8 ia_exemplos_conversa ativos, filtrados por tag do funil
//   8  claude           Messages API (fetch), tools propor_agendamento / encaminhar_humano
//   9  pos_validacao    filtro regex CFM na resposta do modelo
//   10 tools            executa as ferramentas (ic-agendamento 'propor', handoffs)
//   11 envio            provedor do numero (_shared/whatsapp-envio.ts: Meta ou Gupshup) + crm_conversas autor 'ia'
//
// MODO SOMBRA: se ic_flag('envio_whatsapp_cloud_api') for false, ou o numero do
// vendedor nao tiver provedor configurado, ou faltar a credencial dele, TUDO roda igual, mas nada e enviado: decisao='simulada_envio_desligado'
// e a resposta que teria saido fica em ia_decisoes_log.detalhe.resposta.
//
// LGPD / MINIMIZACAO: para a Anthropic vai so o system prompt (_shared/ia-prompt.ts),
// o primeiro nome, funil/etapa, o texto das ultimas 12 mensagens e os exemplos.
// Em ia_decisoes_log.dados_enviados_resumo entram apenas contagens e tipos.
//
// CFM 2.336/2023: regras no prompt E em codigo (handoff-regras antes da IA,
// pos-validacao depois). A IA nunca confirma horario: so PROPOE (status pendente).
//
// VARIAVEIS DE AMBIENTE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (o Supabase injeta)
//   IC_INTERNAL_SECRET            autoriza a chamada do webhook e as chamadas a ic-agendamento
//   ANTHROPIC_API_KEY             Messages API da Anthropic
//   META_ACCESS_TOKEN             envio pela Cloud API, provedor 'meta' (ausente = modo sombra)
//   GUPSHUP_API_KEY               envio pelo Gupshup, provedor 'gupshup' (ausente = modo sombra)
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
import { chamadaInternaValida, headersInternos } from "../_shared/auth.ts";
import { iaConfig, icFlag } from "../_shared/flags.ts";
import { canonicoTelefone, telefoneBrPlausivel } from "../_shared/telefone.ts";
import { canalDoVendedor, type CanalEnvio, enviarTextoCanal } from "../_shared/whatsapp-envio.ts";
import { detectarHandoff } from "../_shared/handoff-regras.ts";
import { respostaProibida } from "../_shared/pos-validacao.ts";
import { interpretarConsentimento } from "../_shared/consentimento.ts";
import { dentroDoHorario, partesNoFuso, TZ_PADRAO } from "../_shared/horario.ts";
import {
  FERRAMENTAS,
  montarSystemPrompt,
  TEXTO_CONSENTIMENTO_NEGADO,
  TEXTO_HANDOFF_GENERICO,
  TEXTO_RESPOSTA_BLOQUEADA,
  textoForaDoHorario,
  textoPedidoConsentimento,
  TOOL_ENCAMINHAR_HUMANO,
  TOOL_PROPOR_AGENDAMENTO,
  type ExemploConversa,
} from "../_shared/ia-prompt.ts";

const LOG = "[ic-ia-pre-atendimento]";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_ANTHROPIC_MS = 25000;
const LIMITE_CONTEXTO = 12;

type Body = { cliente_crm_id: string; conversa_id: string | null; vendedor_id: string | null; funil_id: string | null };

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
  constructor(sb: SupabaseClient, body: Body) {
    this.sb = sb;
    this.body = body;
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

  async temHandoffPendente(): Promise<boolean> {
    const { data, error } = await this.sb
      .from("ia_handoffs")
      .select("id")
      .eq("cliente_crm_id", this.body.cliente_crm_id)
      .is("atendido_em", null)
      .limit(1);
    if (error) {
      console.warn(LOG, "ia_handoffs consulta falhou:", error.message);
      return false;
    }
    return !!(data && data.length);
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
    const envio = await enviarTextoCanal(this.canal, this.para, texto, LOG);
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

  // 2) humano_assumiu
  const desde24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: humano } = await sb
    .from("crm_conversas")
    .select("id")
    .eq("cliente_crm_id", body.cliente_crm_id)
    .eq("direcao", "enviada")
    .eq("autor", "vendedor")
    .gte("criada_em", desde24h)
    .limit(1);
  if (humano && humano.length) {
    await p.log("humano_assumiu", "humano_no_controle", { motivo: "vendedor respondeu nas ultimas 24h" });
    return { ok: true, decisao: "humano_no_controle" };
  }
  if (await p.temHandoffPendente()) {
    await p.log("humano_assumiu", "humano_no_controle", { motivo: "handoff pendente" });
    return { ok: true, decisao: "humano_no_controle" };
  }
  await p.log("humano_assumiu", "ia_pode_responder");

  // Envio: flag + canal (provedor, numero e credencial) do vendedor do card.
  // Sem isso = modo sombra.
  p.envioLigado = await icFlag(sb, "envio_whatsapp_cloud_api");
  const vendedorId = String((card as any).vendedor_id || body.vendedor_id || "");
  let motivoSemCanal = "card_sem_vendedor";
  if (vendedorId) {
    const res = await canalDoVendedor(sb, vendedorId);
    if (res.ok) p.canal = res.canal;
    else motivoSemCanal = res.erroBanco ? "erro_banco" : res.motivo;
  }
  if (!p.envioLigado || !p.canal) {
    console.log(LOG, "modo sombra:", { flag: p.envioLigado, provedor: p.canal?.provedor ?? null, motivo: p.canal ? null : motivoSemCanal });
  }

  // 3) limites
  const agora = new Date();
  if (!dentroDoHorario(agora, cfg.horario_inicio || "08:00", cfg.horario_fim || "19:00", TZ_PADRAO)) {
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
  const maxRespostas = Math.max(1, Number(cfg.max_respostas_por_conversa || "6") || 6);
  const { count: respostasDadas } = await sb
    .from("ia_decisoes_log")
    .select("id", { count: "exact", head: true })
    .eq("cliente_crm_id", body.cliente_crm_id)
    .eq("resposta_enviada", true);
  if ((respostasDadas || 0) >= maxRespostas) {
    await p.handoff("manual", "limite de respostas da IA");
    await p.log("limites", "limite_respostas", { motivo: `${respostasDadas}/${maxRespostas}` });
    return { ok: true, decisao: "limite_respostas" };
  }
  await p.log("limites", "ok", { detalhe: { respostas: respostasDadas || 0, max: maxRespostas } });

  // 4) contexto
  const { data: ctxRaw, error: errCtx } = await sb.rpc("ic_ia_contexto", {
    p_cliente: body.cliente_crm_id,
    p_limite: LIMITE_CONTEXTO,
  });
  if (errCtx || !ctxRaw) {
    await p.log("contexto", "erro", { motivo: errCtx ? errCtx.message : "vazio" });
    return { ok: false, erro: "contexto" };
  }
  const ctx = ctxRaw as Contexto;
  ctx.mensagens = Array.isArray(ctx.mensagens) ? ctx.mensagens : [];
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
  const { data: consRows } = await sb
    .from("ia_consentimentos")
    .select("id, status, texto_apresentado")
    .eq("cliente_crm_id", body.cliente_crm_id)
    .limit(1);
  let cons: any = consRows && consRows[0] ? consRows[0] : null;
  const statusCons = String((cons && cons.status) || ctx.consentimento || "pendente").toLowerCase();

  if (statusCons === "negado" || statusCons === "revogado") {
    await p.log("consentimento", "negado_anteriormente");
    return { ok: true, decisao: "consentimento_negado" };
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
      await p.enviar(TEXTO_CONSENTIMENTO_NEGADO, "consentimento", "negado_despedida");
      return { ok: true, decisao: "consentimento_negado" };
    }
    if (resp === "ambiguo") {
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

  // 6) handoff_regras (codigo, antes da IA)
  const hd = detectarHandoff(textoLead);
  if (hd) {
    await p.handoff(hd.motivo, `regra '${hd.termo}'`);
    await p.log("handoff_regras", hd.motivo, { motivo: hd.termo });
    if (hd.resposta_fixa) await p.enviar(hd.resposta_fixa, "envio", "enviada_fixa", { origem: "handoff_regras", motivo: hd.motivo });
    return { ok: true, decisao: "handoff_" + hd.motivo };
  }
  await p.log("handoff_regras", "nenhuma");

  // 7) exemplos
  let exemplos: ExemploConversa[] = [];
  try {
    const { data: ex } = await sb
      .from("ia_exemplos_conversa")
      .select("titulo, contexto, mensagem_lead, resposta_ideal, tags")
      .eq("ativo", true)
      .limit(40);
    const todos = ((ex as any[]) || []).filter((e) => e && e.mensagem_lead && e.resposta_ideal);
    const funilNorm = String(ctx.funil || "").toLowerCase();
    const casam = funilNorm
      ? todos.filter((e) => Array.isArray(e.tags) && e.tags.some((t: string) => funilNorm.includes(String(t).toLowerCase()) || String(t).toLowerCase().includes(funilNorm)))
      : [];
    exemplos = (casam.length ? casam : todos).slice(0, 8);
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
    await p.enviar(TEXTO_RESPOSTA_BLOQUEADA, "envio", "enviada_fixa", { origem: "erro_ia" });
    return { ok: true, decisao: "erro_ia" };
  }
  await p.log("claude", "respondeu", {
    modelo: p.modelo, tokens_entrada: r.tokens_entrada, tokens_saida: r.tokens_saida, latencia_ms: r.latencia_ms,
    dados_enviados_resumo: resumo, detalhe: { stop_reason: r.stop_reason, tools: r.tools.map((t) => t.name), chars_resposta: r.texto.length },
  });

  // 9) pos_validacao
  let textoResposta = r.texto;
  const proibido = textoResposta ? respostaProibida(textoResposta) : null;
  if (proibido) {
    await p.log("pos_validacao", "bloqueada_pos_validacao", { modelo: p.modelo, motivo: proibido, detalhe: { resposta: textoResposta } });
    await p.handoff("erro_ia", "resposta bloqueada");
    await p.enviar(TEXTO_RESPOSTA_BLOQUEADA, "envio", "enviada_fixa", { origem: "pos_validacao", termo: proibido });
    return { ok: true, decisao: "bloqueada_pos_validacao" };
  }
  await p.log("pos_validacao", textoResposta ? "ok" : "sem_texto");

  // 10) tools
  const marcadores: Record<string, unknown> = {};
  for (const t of r.tools) {
    if (t.name === TOOL_ENCAMINHAR_HUMANO) {
      const motivoBruto = String(t.input?.motivo || "outro");
      const motivo: MotivoHandoffDb = (["duvida_clinica", "urgencia", "reclamacao", "pedido_humano"] as string[]).includes(motivoBruto)
        ? (motivoBruto as MotivoHandoffDb)
        : "manual";
      await p.handoff(motivo, "IA: " + String(t.input?.detalhe || motivoBruto));
      await p.log("tools", "encaminhar_humano", { motivo });
      if (!textoResposta) textoResposta = TEXTO_HANDOFF_GENERICO;
      marcadores.handoff = motivo;
    } else if (t.name === TOOL_PROPOR_AGENDAMENTO) {
      const resultado = await proporAgendamento(body.cliente_crm_id, t.input || {});
      await p.log("tools", resultado.ok ? "propor_agendamento" : "propor_agendamento_falhou", {
        motivo: resultado.ok ? null : resultado.erro, detalhe: { agendamento_id: resultado.agendamento_id, confirmado: resultado.confirmado },
      });
      if (resultado.confirmado) await p.handoff("agendamento_confirmado", "agendamento " + resultado.agendamento_id);
      if (!textoResposta) {
        textoResposta = resultado.ok
          ? "Anotei a sua preferência de horário! A nossa equipe vai confirmar com você por aqui em breve. 😊"
          : TEXTO_HANDOFF_GENERICO;
      }
      marcadores.agendamento_id = resultado.agendamento_id;
    } else {
      await p.log("tools", "ferramenta_desconhecida", { motivo: t.name });
    }
  }
  if (!textoResposta) {
    await p.log("envio", "sem_texto");
    return { ok: true, decisao: "sem_texto" };
  }

  // 11) envio
  const env = await p.enviar(textoResposta, "envio", "enviada", { tools: r.tools.map((t) => t.name) }, marcadores);
  return { ok: true, decisao: env.enviado ? "enviada" : "simulada_envio_desligado" };
}

// Chama ic-agendamento internamente (acao 'propor'). Nunca confirma: status pendente.
async function proporAgendamento(
  clienteId: string,
  input: any,
): Promise<{ ok: boolean; confirmado: boolean; agendamento_id: string | null; erro: string | null }> {
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
        servico: String(input.servico || "Avaliação").slice(0, 120),
        observacao: String(input.observacao || "").slice(0, 300),
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      console.error(LOG, "ic-agendamento propor falhou:", resp.status, JSON.stringify(data).slice(0, 200));
      return { ok: false, confirmado: false, agendamento_id: null, erro: data && data.erro ? String(data.erro) : `http_${resp.status}` };
    }
    return { ok: true, confirmado: data.confirmado === true, agendamento_id: data.agendamento_id ? String(data.agendamento_id) : null, erro: null };
  } catch (e) {
    console.error(LOG, "ic-agendamento propor excecao:", e instanceof Error ? e.message : e);
    return { ok: false, confirmado: false, agendamento_id: null, erro: "excecao" };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo_nao_suportado" }, 405);
  if (!chamadaInternaValida(req)) return json({ ok: false, erro: "nao_autorizado" }, 401);

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
    const clienteId = String(body.cliente_crm_id || "").trim();
    if (!clienteId) return json({ ok: false, erro: "payload_invalido" }, 400);

    const sb = createClient(URL_SB, SR, { auth: { persistSession: false } });
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
