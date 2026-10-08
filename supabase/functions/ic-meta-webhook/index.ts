// ic-meta-webhook: webhook da API OFICIAL da Meta (WhatsApp Cloud API) para o
// IC CRM (Instituto Castro de Medicina).
//
// Regras de negocio: as descritas neste cabecalho e nos blocos abaixo.
//
// RECURSOS DO IC CRM (03/10/2026):
// - Prefixo de log [ic-meta-webhook].
// - Normalizacao de telefone importada de ../_shared/telefone.ts (mesmo codigo,
//   compartilhado com ic-whatsapp-send para os dois lados gerarem o mesmo canonico).
// - Transcricao de audio atras da feature flag ic_flag('ia_transcricao_audio')
//   (cache 60 s). Flag desligada: audio entra com o placeholder, sem chamar o Groq.
// - Placeholders de midia legiveis: [Imagem recebida], [Vídeo recebido],
//   [Documento recebido] nome.pdf, [Sticker recebido], [Localização recebida],
//   [Contato recebido] Nome. Legenda e nome de arquivo preservados.
// - Gancho da IA: mensagem RECEBIDA do lead (nao eco, nao numero da casa, com
//   card) dispara ic-ia-pre-atendimento em segundo plano (EdgeRuntime.waitUntil)
//   quando ic_flag('ia_pre_atendimento') esta ligada. Erro ali nunca derruba o
//   webhook. O ECO (equipe respondeu pelo celular) NAO dispara IA: ele e gravado
//   com autor 'vendedor', e e exatamente essa linha que a IA le como "humano
//   assumiu" nas proximas 24 h.
//
// VARIAVEIS DE AMBIENTE:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (o Supabase injeta)
//   META_VERIFY_TOKEN   GET de verificacao do webhook
//   META_APP_SECRET     assinatura X-Hub-Signature-256 de cada POST
//   META_ACCESS_TOKEN   baixar midia (audio) pela Graph API
//   GROQ_API_KEY        transcricao de audio (Whisper)
//   IC_INTERNAL_SECRET  header x-ic-internal ao chamar ic-ia-pre-atendimento
//
//   GUPSHUP_WEBHOOK_TOKEN  segredo na URL do webhook do Gupshup (?token=...)
//   GUPSHUP_API_KEY     baixar midia (audio) pelo Gupshup
//
// Publicar: supabase functions deploy ic-meta-webhook --no-verify-jwt
//
// GUPSHUP (BSP, modo coexistencia) - 08/10/2026:
// A mesma funcao recebe o webhook do Gupshup em
//   .../functions/v1/ic-meta-webhook?provedor=gupshup&token=<GUPSHUP_WEBHOOK_TOKEN>
// - O Gupshup nao documenta assinatura de webhook. A autenticidade e o token da
//   URL, comparado em tempo constante. Sem o segredo configurado, tudo e recusado.
// - Formato Gupshup (v2): convertido para o envelope da Meta em
//   _shared/gupshup.ts (envelopeGupshup) e processado pelo MESMO caminho abaixo.
//   O numero e achado por vendedores_whatsapp.gupshup_app (campo "app" do evento).
// - Formato Meta (v3) e eventos de coexistencia (smb_message_echoes etc.): o
//   Gupshup repassa o envelope da Meta como veio; o numero e achado por
//   gupshup_app_id (gs_app_id), meta_phone_id ou gupshup_app.
// - Midia: v2 traz link (baixado direto); v3 traz so o id (baixado em
//   api.gupshup.io/sm/api/wamedia/{app}/{id} com GUPSHUP_API_KEY).
// - O envelope gravado em crm_entrada_bruta (origem 'gupshup') ja e o
//   convertido, com _ic_provedor e o evento original em _ic_original: o
//   varredor reprocessa sem saber de Gupshup.
//
// ---------------------------------------------------------------------------
// Recebe os eventos da Cloud API da Meta e acha o vendedor por meta_phone_id
// (a coluna zapi_instancia continua existindo para quem usar o envio pelo Z-API).
//
// O QUE ELA FAZ:
// - Identifica o vendedor, acha ou cria o card do lead em clientes_crm e grava a
//   mensagem em crm_conversas. Atualiza lead_chegou_em, primeira_resposta_em,
//   ultima_mensagem_em e ultima_mensagem_direcao.
// - NAO responde, NAO usa IA (so dispara a funcao de IA em segundo plano, ver
//   acima), NUNCA move o card de coluna.
// - Sempre devolve 200 (a Meta reenvia em laco quando recebe erro).
// - verify_jwt=false (webhook publico da Meta).
//
// REGRAS DE NEGOCIO PRESERVADAS SEM ALTERACAO:
// - soDigitos / variacoesTelefone / canonicoTelefone / mesmoNumero: mesma
//   normalizacao dos dois lados. Reconhecimento pelo NUMERO COMPLETO, nunca pelos
//   4 ultimos nem pelo nome. Busca sempre filtrada pelo vendedor dono do numero.
// - Busca em DOIS CAMINHOS. O caminho legado (cards com numero_whatsapp vazio e
//   telefone formatado "+55 (11) 9....") segura 92% da base do vendedor 8 hoje.
//   Ele NAO e detalhe secundario: se falhar, nascem milhares de cards duplicados.
// - Card encontrado pelo caminho legado tem numero_whatsapp preenchido com o
//   canonico, migrando a base para o caminho rapido com o tempo.
// - Card existente so sobe na coluna onde ja esta (bump de ultima_mensagem_em).
//   Card soft-deleted e reativado NA MESMA COLUNA, com registro em crm_historico.
// - Trava anti-duplicata por zapi_message_id (aqui guarda o wamid da Meta).
//   O NOME DA COLUNA MENTE, e fica assim de proposito: em setembro/2026 as
//   17.116 mensagens gravadas tinham id no formato wamid., nenhuma do Z-API.
//   Renomear a coluna mexeria em front, funcoes e indice unico de uma vez, para
//   nao mudar comportamento nenhum. Decisao do Alexandre: anotar, nao renomear.
// - Nunca grava mensagem vazia (placeholderPorTipo).
// - anuncio_id e ctwa_token NUNCA sao sobrescritos: vale o primeiro anuncio.
// - Card so nasce com telefone brasileiro plausivel (telefoneBrPlausivel).
//
// O QUE MUDA EM RELACAO AO Z-API:
// a) GET de verificacao com hub.mode / hub.verify_token / hub.challenge.
// b) Todo POST vem assinado em X-Hub-Signature-256 (HMAC-SHA256 do corpo CRU).
// c) Payload em entry[].changes[].value, com varias mensagens por chamada.
// d) Vendedor pelo metadata.phone_number_id, na coluna nova meta_phone_id.
// e) Telefone do lead sempre real. A Meta NAO tem LID.
// f) Mensagem do vendedor chega no campo separado smb_message_echoes, e nela o
//    lead esta em "to", nao em "from".
// g) Midia vem so como id: precisa de 2 chamadas na Graph API para baixar.
// h) Anuncio vem em messages[].referral (nao em externalAdReply).
// i) Identificador da mensagem e o wamid.
// j) history e smb_app_state_sync sao IGNORADOS (criariam milhares de cards falsos).
// k) statuses (entregue, lido, tocado) sao IGNORADOS por enquanto.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Cliente sem tipos gerados do banco (o schema nao e tipado aqui).
type Supa = SupabaseClient<any, "public", any>;
import { canonicoTelefone, soDigitos, telefoneBrPlausivel, variacoesTelefone } from "../_shared/telefone.ts";
import { icFlag } from "../_shared/flags.ts";
import { baixarMidiaGupshup, envelopeGupshup, tokenWebhookValido } from "../_shared/gupshup.ts";

type Provedor = "meta" | "gupshup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Versao da Graph API usada so para baixar midia. Trocar aqui quando a Meta
// descontinuar. O endpoint de midia e estavel entre versoes.
const GRAPH_VERSION = "v23.0";

// LISTA BRANCA de campos processados. Tudo que nao estiver aqui e ignorado.
// Lista branca (e nao lista negra) de proposito: campo novo que a Meta invente
// no futuro ja nasce ignorado, em vez de virar cadastro errado no CRM.
const CAMPOS_PROCESSADOS = new Set(["messages", "smb_message_echoes"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------
// PORTA DE ENTRADA: colisao de unicidade e falha que nao pode sumir.
//
// Ate 24/09/2026, insert que falhava aqui virava console.error e o webhook
// devolvia sucesso. A mensagem do lead sumia sem card, sem conversa gravada
// e sem rastro: nem dava para contar depois quantas tinham sumido. Agora
// toda falha de escrita vira linha em crm_entrada_falhas, com telefone,
// motivo e o evento cru.
//
// A colisao chega junto com o indice unico crm_card_unico_por_funil, que
// impede dois cards da mesma pessoa no mesmo funil. Dois eventos do mesmo
// WhatsApp chegando no mesmo instante procuravam o card, nao achavam, e
// criavam cada um o seu. Agora o segundo leva 23505 e cai no tratamento.
//
// O 23505 e capturado a mao de proposito, sem "on conflict": o indice e
// parcial e o predicado carrega o literal do marco. on conflict exigiria
// predicado identico e quebraria calado no dia em que o marco mudasse.
//
// Quem decide o que e "card vivo desta pessoa neste funil" e o banco, em
// fn_crm_card_vivo_no_funil, com os mesmos criterios do indice. Aqui nao se
// normaliza telefone.
// ---------------------------------------------------------------------

const ORIGEM_FALHA = "meta";

function ehColisaoUnicidade(err: any): boolean {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  return code === "23505" || msg.includes("duplicate key value");
}

async function registrarFalhaEntrada(
  supabase: any,
  dados: {
    etapa: string;
    telefone?: string | null;
    funil_id?: string | null;
    vendedor_id?: string | null;
    motivo: string;
    erro?: any;
    payload?: unknown;
  },
): Promise<void> {
  const linha = {
    origem: (dados.payload as any)?.fonte === "gupshup" ? "gupshup" : ORIGEM_FALHA,
    etapa: dados.etapa,
    telefone: dados.telefone || null,
    funil_id: dados.funil_id || null,
    vendedor_id: dados.vendedor_id || null,
    motivo: dados.motivo,
    sqlstate: dados.erro && dados.erro.code ? String(dados.erro.code) : null,
    erro_detalhe: dados.erro ? String(dados.erro.message || dados.erro) : null,
    payload: dados.payload ?? null,
  };
  try {
    const { error } = await supabase.from("crm_entrada_falhas").insert(linha);
    if (error) {
      // Ultimo recurso, nao o primeiro: se nem a tabela de falha aceita, sobra o console.
      console.error(
        "[" + ORIGEM_FALHA + "] crm_entrada_falhas recusou a linha:",
        error,
        JSON.stringify(linha).slice(0, 800),
      );
    }
  } catch (e) {
    console.error(
      "[" + ORIGEM_FALHA + "] excecao ao gravar crm_entrada_falhas:",
      e,
      JSON.stringify(linha).slice(0, 800),
    );
  }
}

// ---------------------------------------------------------------------
// MENSAGEM REPETIDA: a mesma mensagem chegando de novo nao e erro.
//
// Medido em 24/09/2026: 108 ids gravados mais de uma vez, por entrega
// concorrente (milissegundos) e por reenvio do provedor (segundos a minutos,
// ate 5 copias). O select antes do insert nao segura corrida. A trava e o
// indice unico crm_conversa_unica_por_instancia em (zapi_message_id,
// vendedor_id); o 23505 cai aqui.
//
// Detalhe que decide: a Meta manda a mesma mensagem duas vezes, uma como
// "unsupported" (vira placeholder "[mensagem nao suportada]") e outra com o
// texto real, no mesmo segundo. Em 11 de 25 pares o placeholder chegou
// primeiro. Se a copia traz conteudo real e a linha gravada e placeholder, a
// linha gravada e atualizada: reconhecer a repeticao nao pode custar o texto.
//
// Cada copia reconhecida vira uma linha em crm_conversas_repetidas, que e o
// contador da trava. Nao e falha, entao nao vai para crm_entrada_falhas.
// ---------------------------------------------------------------------

async function tratarConversaRepetida(
  supabase: any,
  dados: {
    messageId: string;
    vendedorId: string;
    clienteId: string | null;
    tipo: string;
    mensagem: string;
    payloadRaw: unknown;
  },
): Promise<{ reconhecida: boolean; atualizou: boolean }> {
  try {
    const { data: existente, error: errSel } = await supabase
      .from("crm_conversas")
      .select("id, tipo, mensagem, cliente_crm_id")
      .eq("zapi_message_id", dados.messageId)
      .eq("vendedor_id", dados.vendedorId)
      .order("criada_em", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (errSel || !existente) {
      // Colidiu e nao aparece na releitura: isso sim e falha de verdade.
      await registrarFalhaEntrada(supabase, {
        etapa: "conversa",
        vendedor_id: dados.vendedorId,
        motivo: "mensagem repetida sem linha visivel na releitura (" + dados.messageId + ")",
        erro: errSel,
        payload: dados.payloadRaw,
      });
      return { reconhecida: false, atualizou: false };
    }

    let atualizou = false;
    const existenteEhPlaceholder = String((existente as any).tipo || "") === "outro";
    if (existenteEhPlaceholder && dados.tipo !== "outro") {
      const { error: errUpd } = await supabase
        .from("crm_conversas")
        .update({ mensagem: dados.mensagem, tipo: dados.tipo, payload_raw: dados.payloadRaw })
        .eq("id", (existente as any).id);
      if (errUpd) {
        await registrarFalhaEntrada(supabase, {
          etapa: "conversa",
          vendedor_id: dados.vendedorId,
          motivo: "placeholder nao pode ser atualizado com o conteudo real (" + dados.messageId + ")",
          erro: errUpd,
          payload: dados.payloadRaw,
        });
      } else {
        atualizou = true;
      }
    }

    const { error: errLog } = await supabase.from("crm_conversas_repetidas").insert({
      origem: ORIGEM_FALHA,
      zapi_message_id: dados.messageId,
      vendedor_id: dados.vendedorId,
      cliente_crm_id: dados.clienteId || (existente as any).cliente_crm_id || null,
      tipo_existente: (existente as any).tipo || null,
      tipo_novo: dados.tipo,
      atualizou_placeholder: atualizou,
    });
    if (errLog) {
      // O contador falhou, a mensagem nao. Fica no console: nao vale abrir falha por isso.
      console.error("[" + ORIGEM_FALHA + "] crm_conversas_repetidas recusou a linha:", errLog);
    }
    console.log("[" + ORIGEM_FALHA + "] mensagem repetida reconhecida:", dados.messageId, atualizou ? "(placeholder atualizado)" : "");
    return { reconhecida: true, atualizou };
  } catch (e) {
    console.error("[" + ORIGEM_FALHA + "] excecao ao tratar mensagem repetida:", e);
    return { reconhecida: false, atualizou: false };
  }
}

async function cardVivoNoFunil(
  supabase: any,
  telefone: string,
  funilId: string | null,
): Promise<string | null> {
  if (!telefone || !funilId) return null;
  const { data, error } = await supabase.rpc("fn_crm_card_vivo_no_funil", {
    p_telefone: telefone,
    p_funil_id: funilId,
  });
  if (error) {
    console.error("[" + ORIGEM_FALHA + "] fn_crm_card_vivo_no_funil falhou:", error);
    return null;
  }
  return (data as string) || null;
}

// ===================================================================
// NORMALIZACAO DE TELEFONE
// E o que segura o reconhecimento dos cards antigos. Nao mexer.
//
// IC CRM: soDigitos, variacoesTelefone, canonicoTelefone e telefoneBrPlausivel
// moram agora em ../_shared/telefone.ts (importados no topo), com o MESMO
// codigo, para que ic-whatsapp-send gere o mesmo canonico que este webhook.
// mesmoNumero e ehLid continuam aqui porque so o webhook os usa.
// ===================================================================

// REGRA 1: reconhecimento pelo NUMERO COMPLETO, normalizando OS DOIS LADOS.
// O valor armazenado pode vir formatado ("+55 (11) 97806-4033") em cards legados; aqui
// removemos tudo que nao e digito, geramos as variacoes (55/9) e testamos interseccao com
// as variacoes do numero que chegou. NUNCA compara pelos 4 ultimos nem pelo nome.
function mesmoNumero(armazenadoRaw: string, variantesLead: Set<string>): boolean {
  if (!armazenadoRaw) return false;
  const vs = variacoesTelefone(armazenadoRaw);
  for (const v of vs) if (variantesLead.has(v)) return true;
  return false;
}

// A Meta NAO usa LID: wa_id / from / to sao sempre telefone real em formato
// internacional. Mantido como guarda defensiva, para que um valor estranho nunca
// vire card novo, e para manter vivo o caminho de busca por chat_lid dos cards
// antigos. Em operacao normal isto sempre devolve false.
function ehLid(valor: string): boolean {
  const v = String(valor || "");
  if (v.includes("@lid")) return true;
  return v.replace(/\D/g, "").length > 13;
}

// telefoneBrPlausivel ("55" + 10 ou 11 digitos): importada de ../_shared/telefone.ts.
// So criamos card quando o numero passa nela. Card errado e pior do que nao criar.

function ehMensagemDeCampanha(texto: string): boolean {
  if (!texto) return false;
  const t = String(texto).toLowerCase();
  // Meta manda algo tipo "...via seu anúncio..." ou vem link. Heuristica minima.
  return t.includes("anúncio") || t.includes("anuncio") || /https?:\/\//.test(t);
}

// ===================================================================
// VERIFICACAO E ASSINATURA (especificos da Meta)
// ===================================================================

// (a) A Meta valida a posse do endereco com um GET. Se o token bater com o
// secret META_VERIFY_TOKEN, devolvemos o hub.challenge em TEXTO PURO (sem JSON,
// sem aspas), que e o que ela espera.
function verificarWebhook(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode") || "";
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";
  const esperado = Deno.env.get("META_VERIFY_TOKEN") || "";

  if (mode === "subscribe" && esperado && token === esperado) {
    console.log("[ic-meta-webhook] verificacao OK");
    return new Response(challenge, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }
  console.warn("[ic-meta-webhook] verificacao REJEITADA", { mode, temToken: !!token });
  return new Response("forbidden", { status: 403, headers: corsHeaders });
}

// (b) Assinatura X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 do corpo CRU,
// com META_APP_SECRET como chave. Precisa ser calculada sobre os BYTES exatos que
// chegaram: reserializar o JSON ja convertido daria assinatura diferente e nada
// passaria. Comparacao em tempo constante para nao vazar o valor por timing.
async function assinaturaValida(
  corpoCru: Uint8Array,
  cabecalho: string,
  segredo: string,
): Promise<boolean> {
  const h = String(cabecalho || "").trim();
  if (!h.startsWith("sha256=")) return false;
  const esperado = h.slice(7).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(esperado)) return false;

  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", chave, corpoCru as BufferSource);
  const calculado = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (calculado.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < calculado.length; i++) {
    diff |= calculado.charCodeAt(i) ^ esperado.charCodeAt(i);
  }
  return diff === 0;
}

// ===================================================================
// ETAPA INICIAL DO FUNIL
// ===================================================================

// Descobre a PRIMEIRA etapa (ordem = 1) do funil pra usar como etapa inicial do lead novo.
// Sem chumbar nome. Se der erro ou funil nao tiver etapas, cai em 'cliente_novo' (nossa
// primeira coluna real nos dois funis atuais: FullStack e Automacao).
async function descobrirPrimeiraEtapa(
  supabase: Supa,
  funilId: string | null,
): Promise<string> {
  const FALLBACK = "cliente_novo";
  if (!funilId) {
    console.warn("[ic-meta-webhook] descobrirPrimeiraEtapa: sem funil, usando fallback", FALLBACK);
    return FALLBACK;
  }
  try {
    const { data, error } = await supabase
      .from("crm_funil_etapas")
      .select("nome")
      .eq("funil_id", funilId)
      .order("ordem", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("[ic-meta-webhook] descobrirPrimeiraEtapa erro:", error.message);
      return FALLBACK;
    }
    const nome = data && (data as any).nome;
    if (!nome) {
      console.warn("[ic-meta-webhook] funil sem etapas, usando fallback", { funilId });
      return FALLBACK;
    }
    return String(nome);
  } catch (e) {
    console.warn("[ic-meta-webhook] descobrirPrimeiraEtapa excecao:", e);
    return FALLBACK;
  }
}

// ===================================================================
// MIDIA (g): a Meta manda so um id. Sao 2 chamadas para ter o arquivo.
// ===================================================================

// Passo 1: pergunta a Graph API qual e a URL do arquivo. Passo 2: baixa a URL
// mandando o token no cabecalho (sem token o download falha). A URL devolvida
// EXPIRA EM 5 MINUTOS, por isso os dois passos ficam juntos aqui.
// Falha suave: qualquer tropeco devolve null e o chamador grava o texto
// substituto, sem quebrar o webhook.
async function baixarMidiaMeta(
  mediaId: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  const token = Deno.env.get("META_ACCESS_TOKEN") || "";
  if (!token) {
    console.warn("[ic-meta-webhook] META_ACCESS_TOKEN ausente; midia gravada como placeholder");
    return null;
  }
  if (!mediaId) return null;
  try {
    const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) {
      console.error("[midia] consulta do id falhou:", mediaId, meta.status);
      return null;
    }
    const info: any = await meta.json();
    const url = info && info.url ? String(info.url) : "";
    if (!url) {
      console.error("[midia] resposta sem url:", mediaId);
      return null;
    }
    const arq = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!arq.ok) {
      console.error("[midia] download falhou:", mediaId, arq.status);
      return null;
    }
    return {
      bytes: await arq.arrayBuffer(),
      mimeType: String(info.mime_type || arq.headers.get("content-type") || "application/octet-stream"),
    };
  } catch (e) {
    console.error("[midia] excecao:", e);
    return null;
  }
}

// Escolhe de onde baixar o audio. Meta: pelo id na Graph API. Gupshup: pelo
// link (formato v2) ou pelo id na API do Gupshup (formato v3/coexistencia).
async function baixarAudio(
  provedor: Provedor,
  vendedor: VendedorWa,
  audio: any,
): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  if (provedor === "gupshup") {
    return await baixarMidiaGupshup({
      url: audio && audio.url ? String(audio.url) : "",
      mediaId: audio && audio.id ? String(audio.id) : "",
      app: vendedor.gupshup_app || "",
      mimeType: audio && audio.mime_type ? String(audio.mime_type) : "",
      apiKey: Deno.env.get("GUPSHUP_API_KEY") || "",
      prefixoLog: "[ic-meta-webhook][gupshup]",
    });
  }
  return audio && audio.id ? await baixarMidiaMeta(String(audio.id)) : null;
}

// Transcricao de audio via Groq Whisper (mesmo padrao do webhook Z-API).
// Diferenca: aqui recebe os BYTES ja baixados da Meta, porque a Meta nao entrega
// URL publica. Chave via secret GROQ_API_KEY (nunca hardcoded). Se o secret faltar
// ou algo falhar, retorna null e o chamador grava um placeholder.
async function transcreverAudioGroq(bytes: ArrayBuffer, mimeType: string): Promise<string | null> {
  const key = Deno.env.get("GROQ_API_KEY") || "";
  if (!key) {
    console.warn("[ic-meta-webhook] GROQ_API_KEY ausente; audio gravado sem transcricao");
    return null;
  }
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    // WhatsApp entrega ogg/opus; o Whisper do Groq aceita direto.
    const tipo = mimeType && mimeType.includes("/") ? mimeType.split(";")[0] : "audio/ogg";
    const ext = tipo.includes("mp4") ? "mp4" : tipo.includes("mpeg") ? "mp3" : "ogg";
    const blob = new Blob([bytes], { type: tipo });
    const fd = new FormData();
    fd.append("file", blob, `audio.${ext}`);
    fd.append("model", "whisper-large-v3");
    fd.append("language", "pt");
    fd.append("response_format", "json");
    const gr = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!gr.ok) {
      const t = await gr.text().catch(() => "");
      console.error("[transcrever] Groq falhou:", gr.status, t.slice(0, 300));
      return null;
    }
    const jr: any = await gr.json();
    const txt = jr && (jr.text || jr.transcription) ? String(jr.text || jr.transcription).trim() : "";
    return txt || null;
  } catch (e) {
    console.error("[transcrever] excecao:", e);
    return null;
  }
}

// ===================================================================
// CONTEUDO DA MENSAGEM
// ===================================================================

// Le o objeto messages[] / message_echoes[] da Meta e define tipo, texto e id da
// midia JUNTOS, na ordem certa. O vocabulario de tipo e EXATAMENTE o mesmo do
// webhook Z-API, para as telas do CRM nao verem diferenca: texto, audio, imagem,
// video, documento, figurinha, contato, localizacao, reacao, enquete, outro.
// mediaId vem preenchido quando ha arquivo para baixar depois.
function extrairConteudoMeta(m: any): { tipo: string; mensagem: string; mediaId: string } {
  const t = String((m && m.type) || "").toLowerCase();

  if (t === "audio" && m.audio) {
    return { tipo: "audio", mensagem: "", mediaId: String(m.audio.id || "") };
  }
  // IC CRM: placeholders legiveis, com legenda / nome do arquivo preservados
  // depois do marcador. O arquivo NAO e baixado (so o id fica em payload_raw).
  if (t === "image" && m.image) {
    const cap = String((m.image.caption ?? "")).trim();
    return { tipo: "imagem", mensagem: ("[Imagem recebida] " + cap).trim(), mediaId: String(m.image.id || "") };
  }
  if (t === "video" && m.video) {
    const cap = String((m.video.caption ?? "")).trim();
    return { tipo: "video", mensagem: ("[Vídeo recebido] " + cap).trim(), mediaId: String(m.video.id || "") };
  }
  if (t === "document" && m.document) {
    const nome = String((m.document.filename ?? m.document.caption ?? "")).trim();
    return { tipo: "documento", mensagem: ("[Documento recebido] " + nome).trim(), mediaId: String(m.document.id || "") };
  }
  if (t === "sticker") {
    return { tipo: "figurinha", mensagem: "[Sticker recebido]", mediaId: "" };
  }
  if (t === "contacts") {
    const lista = Array.isArray(m.contacts) ? m.contacts : [];
    const c = lista[0] || {};
    const n = c.name || {};
    const nome = String(
      (n.formatted_name ?? n.first_name ?? c.displayName ?? ""),
    ).trim();
    return { tipo: "contato", mensagem: ("[Contato recebido] " + nome).trim(), mediaId: "" };
  }
  if (t === "location") {
    return { tipo: "localizacao", mensagem: "[Localização recebida]", mediaId: "" };
  }
  if (t === "reaction" && m.reaction) {
    const v = String((m.reaction.emoji ?? "")).trim();
    return { tipo: "reacao", mensagem: ("reagiu " + v).trim(), mediaId: "" };
  }
  if (t === "text" && m.text) {
    const body = String((m.text.body ?? "")).trim();
    if (body) return { tipo: "texto", mensagem: body, mediaId: "" };
  }
  // Resposta de botao e de lista: para o CRM e texto, igual ao webhook Z-API.
  if (t === "button" && m.button) {
    const body = String((m.button.text ?? m.button.payload ?? "")).trim();
    if (body) return { tipo: "texto", mensagem: body, mediaId: "" };
  }
  if (t === "interactive" && m.interactive) {
    const i = m.interactive;
    const escolha = i.button_reply || i.list_reply || i.nfm_reply || {};
    const body = String((escolha.title ?? escolha.id ?? "")).trim();
    if (body) return { tipo: "texto", mensagem: body, mediaId: "" };
  }
  // Tipos que NAO sao texto mas que o vendedor precisa ver como sao. Antes
  // todos caiam no mesmo "[mensagem nao reconhecida]", que nao dizia nada.
  // O historico ja gravado e traduzido na leitura pela coluna gerada
  // crm_conversas.exibicao; daqui para a frente ja nasce certo.
  if (t === "edit") return { tipo: "outro", mensagem: "[mensagem editada]", mediaId: "" };
  if (t === "revoke") return { tipo: "outro", mensagem: "[mensagem apagada]", mediaId: "" };
  // Nada reconhecido (order, system, unsupported, tipo novo da Meta).
  return { tipo: "outro", mensagem: "[mensagem não suportada]", mediaId: "" };
}

// (h) Anuncio Click To WhatsApp. Na Meta os dados vem em messages[].referral, com
// os campos ja legiveis (nao ha token opaco como no Z-API).
// Aceita SOMENTE source_type "ad" (anuncio pago). "post" (publicacao organica) fica
// de fora de proposito, para nao misturar organico na tabela de anuncios.
// NUNCA gravar image_url / video_url / thumbnail_url: sao links do CDN do Facebook
// que expiram em dias.
// Observacao da Meta: referral so vem na PRIMEIRA mensagem do lead, o que casa com
// a regra de nunca sobrescrever anuncio_id.
// ATRIBUICAO DO GOOGLE.
// O clique do Google cai num link direto do WhatsApp e nao carrega
// identificador nenhum: so o anuncio Click-to-WhatsApp da propria Meta
// preenche o objeto referral. O unico canal que sobrevive e o texto
// pre-preenchido do link (?text=), onde o ValueTrack do Google Ads substitui
// as macros antes do clique. Formato acordado, no fim da mensagem:
//   [ic:{campaignid}:{gclid}]
// Le, guarda e TIRA do texto: o vendedor nunca ve o codigo na conversa.
const MARCA_GOOGLE = /\s*\[ic:([0-9]{1,20}):([A-Za-z0-9_-]{1,300})\]\s*/i;

function extrairMarcaGoogle(texto: string): { campanhaId: string; gclid: string; limpo: string } | null {
  if (!texto) return null;
  const m = MARCA_GOOGLE.exec(texto);
  if (!m) return null;
  const limpo = texto.replace(MARCA_GOOGLE, " ").replace(/\s+/g, " ").trim();
  return { campanhaId: m[1], gclid: m[2], limpo: limpo };
}

type DadosAnuncio = {
  id: string;
  titulo: string | null;
  texto: string | null;
  link: string | null;
  app: string | null;
};
function extrairAnuncioMeta(m: any): DadosAnuncio | null {
  try {
    const ad = m && m.referral;
    if (!ad || typeof ad !== "object") return null;
    if (ad.source_type !== "ad") return null;
    const id = ad.source_id != null ? String(ad.source_id).trim() : "";
    if (!id) return null;
    const limpar = (v: unknown, max: number): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return s ? s.slice(0, max) : null;
    };
    return {
      id: id.slice(0, 100),
      titulo: limpar(ad.headline, 300),
      texto: limpar(ad.body, 2000),
      link: limpar(ad.source_url, 1000),
      // A Meta nao manda o app de origem (instagram/facebook) neste objeto.
      // Marcamos a procedencia para diferenciar do que veio pelo Z-API.
      app: "meta_ads",
    };
  } catch (_e) {
    return null;
  }
}

// Identificador do clique no anuncio. Vai para a MESMA coluna ctwa_token usada
// pelo webhook Z-API (que guardava outro formato de token). A coluna passa a ter
// dois formatos conviventes; ela nunca foi lida por nenhuma tela.
function extrairCtwaClid(m: any): string | null {
  try {
    const ad = m && m.referral;
    if (!ad || typeof ad !== "object") return null;
    const clid = ad.ctwa_clid != null ? String(ad.ctwa_clid).trim() : "";
    return clid ? clid.slice(0, 1000) : null;
  } catch (_e) {
    return null;
  }
}

// Placeholder por tipo, usado na REGRA DURA: nunca gravar mensagem vazia no banco.
function placeholderPorTipo(t: string): string {
  switch (t) {
    case "audio": return "[audio]";
    case "imagem": return "[Imagem recebida]";
    case "video": return "[Vídeo recebido]";
    case "documento": return "[Documento recebido]";
    case "figurinha": return "[Sticker recebido]";
    case "contato": return "[Contato recebido]";
    case "localizacao": return "[Localização recebida]";
    case "reacao": return "[reacao]";
    case "enquete": return "[enquete]";
    case "texto": return "[mensagem sem conteudo]";
    default: return "[mensagem nao reconhecida]";
  }
}

// ===================================================================
// BUSCA DO CARD
// ===================================================================

const SEL_CARD =
  "id, etapa, numero_whatsapp, telefone, chat_lid, campanha_origem, ctwa_token, anuncio_id, google_campanha_id, lead_chegou_em, primeira_resposta_em, nome, vendedor_id, funil_id, deleted_at, mesclado_para";

// (d) Vendedor pelo phone_number_id da Meta, na coluna nova meta_phone_id.
// Nao existe mais instanceId. zapi_instancia continua intacta para o webhook antigo.
type VendedorWa = {
  vendedor_id: string;
  vendedor_nome: string | null;
  numero_whatsapp: string;
  funil_id: string | null;
  gupshup_app?: string | null;
};

// CACHE EM ESCOPO DE MODULO. vendedores_whatsapp tem 3 linhas e muda quando se
// cadastra vendedor, nao a cada mensagem. O isolate sobrevive entre invocacoes,
// entao uma leitura serve para todas as mensagens que chegarem enquanto ele
// estiver quente. TTL curto para cadastro novo aparecer sozinho.
const VENDEDOR_TTL_MS = 5 * 60 * 1000;
let vendedorCache = new Map<string, VendedorWa>();
// Gupshup: por nome do app (minusculo), por id do app (gs_app_id) e pelo
// numero da casa (canonico) dos numeros com provedor 'gupshup'.
let vendedorPorGupshupApp = new Map<string, VendedorWa>();
let vendedorPorGupshupAppId = new Map<string, VendedorWa>();
let vendedorPorGupshupNumero = new Map<string, VendedorWa>();
let vendedorCacheEm = 0;
// Numeros dos proprios vendedores. Numero que esta em vendedores_whatsapp nunca
// pode virar card de lead: eram os vendedores conversando entre si que criaram
// card no pipeline.
let numerosDaCasa = new Set<string>();

async function carregarVendedores(supabase: Supa): Promise<string | null> {
  // select("*") de proposito: funciona antes e depois do SQL 28 (colunas
  // provedor, gupshup_app, gupshup_app_id). Sao poucas linhas.
  const { data, error } = await supabase
    .from("vendedores_whatsapp")
    .select("*");
  if (error) return error.message || "erro desconhecido";
  const mapa = new Map<string, VendedorWa>();
  const porApp = new Map<string, VendedorWa>();
  const porAppId = new Map<string, VendedorWa>();
  const porNumero = new Map<string, VendedorWa>();
  const numeros = new Set<string>();
  for (const r of ((data as any[]) || [])) {
    const canon = canonicoTelefone(String(r.numero_whatsapp || ""));
    if (canon) numeros.add(canon);
    if (!r.ativo) continue;
    const v: VendedorWa = {
      vendedor_id: r.vendedor_id,
      vendedor_nome: r.vendedor_nome ?? null,
      numero_whatsapp: r.numero_whatsapp,
      funil_id: r.funil_id ?? null,
      gupshup_app: r.gupshup_app ?? null,
    };
    if (r.meta_phone_id) mapa.set(String(r.meta_phone_id), v);
    if (r.gupshup_app) porApp.set(String(r.gupshup_app).trim().toLowerCase(), v);
    if (r.gupshup_app_id) porAppId.set(String(r.gupshup_app_id).trim(), v);
    if (String(r.provedor || "") === "gupshup" && canon) porNumero.set(canon, v);
  }
  vendedorCache = mapa;
  vendedorPorGupshupApp = porApp;
  vendedorPorGupshupAppId = porAppId;
  vendedorPorGupshupNumero = porNumero;
  numerosDaCasa = numeros;
  vendedorCacheEm = Date.now();
  return null;
}

// Devolve o vendedor E o motivo de nao ter achado. Antes os dois casos viravam
// null e o log dizia "sem vendedor ativo" tanto para cadastro faltando quanto
// para o banco ter recusado a consulta - que foi o que aconteceu hoje sob
// pressao. Erro de consulta e vazio de cadastro sao coisas diferentes.
async function acharVendedorPorPhoneId(
  supabase: Supa,
  phoneNumberId: string,
): Promise<{ vendedor: VendedorWa | null; erro: string | null }> {
  if (!phoneNumberId) return { vendedor: null, erro: null };
  if (Date.now() - vendedorCacheEm > VENDEDOR_TTL_MS || vendedorCache.size === 0) {
    const erro = await carregarVendedores(supabase);
    if (erro && vendedorCache.size === 0) return { vendedor: null, erro };
  }
  return { vendedor: vendedorCache.get(phoneNumberId) || null, erro: null };
}

// Gupshup: tenta gs_app_id, depois phone_number_id da Meta (v3), depois o nome
// do app (v2 so tem o nome), depois o numero da casa (display_phone_number do
// v3), que ja esta em vendedores_whatsapp.numero_whatsapp. O formato Meta (v3)
// NAO traz o nome do app: sem este ultimo passo, o numero so seria achado com
// gupshup_app_id ou meta_phone_id preenchidos a mao.
async function acharVendedorGupshup(
  supabase: Supa,
  ids: { appId: string; phoneNumberId: string; appName: string; numeroCasa: string },
): Promise<{ vendedor: VendedorWa | null; erro: string | null }> {
  const vazio = vendedorPorGupshupApp.size === 0 && vendedorPorGupshupAppId.size === 0 && vendedorCache.size === 0;
  if (Date.now() - vendedorCacheEm > VENDEDOR_TTL_MS || vazio) {
    const erro = await carregarVendedores(supabase);
    const aindaVazio = vendedorPorGupshupApp.size === 0 && vendedorPorGupshupAppId.size === 0 && vendedorCache.size === 0;
    if (erro && aindaVazio) return { vendedor: null, erro };
  }
  const v = (ids.appId && vendedorPorGupshupAppId.get(ids.appId)) ||
    (ids.phoneNumberId && vendedorCache.get(ids.phoneNumberId)) ||
    (ids.appName && vendedorPorGupshupApp.get(ids.appName.trim().toLowerCase())) ||
    (ids.numeroCasa && vendedorPorGupshupNumero.get(canonicoTelefone(ids.numeroCasa))) ||
    null;
  return { vendedor: v, erro: null };
}

// CAMINHO RAPIDO: cards criados pelo bot ja tem numero_whatsapp no formato canonico.
// Inclui apagados de proposito (a reativacao acontece depois).
async function buscarCardCaminhoRapido(
  supabase: Supa,
  vendedorId: string,
  variantes: string[],
): Promise<any | null> {
  const { data } = await supabase
    .from("clientes_crm")
    .select(SEL_CARD)
    .eq("vendedor_id", vendedorId)
    .in("numero_whatsapp", variantes)
    .is("mesclado_para", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data && data[0]) || null;
}

// TERCEIRO CAMINHO: telefone normalizado dentro do MESMO FUNIL.
// Os dois caminhos acima procuram por vendedor. Este procura pela forma canonica
// do numero (a mesma coluna gerada telefone_norm que a mescla usa) dentro do
// funil do vendedor. E o que impede o duplicado de nascer: 830 cards excedentes
// existem porque nada checava isso antes de criar.
// Nunca entre funis - a mesma pessoa pode estar em Automacao e FullStack ao
// mesmo tempo, e isso e correto.
function normalizarBR(tel: string): string | null {
  const n = String(tel || "").replace(/\D/g, "");
  if (!n) return null;
  if (n.length > 13) return null;
  if ((n.length === 12 || n.length === 13) && n.startsWith("55")) {
    const resto = n.slice(2);
    return resto.length === 10 ? resto.slice(0, 2) + "9" + resto.slice(2) : resto;
  }
  if (n.length === 10) return n.slice(0, 2) + "9" + n.slice(2);
  return n;
}

async function buscarCardPorTelefoneNorm(
  supabase: Supa,
  funilId: string | null,
  telefone: string,
): Promise<any | null> {
  const norm = normalizarBR(telefone);
  if (!norm || !funilId) return null;
  const { data } = await supabase
    .from("clientes_crm")
    .select(SEL_CARD)
    .eq("telefone_norm", norm)
    .eq("funil_id", funilId)
    .is("mesclado_para", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data && data[0]) || null;
}

// CAMINHO LEGADO: cards antigos tem numero_whatsapp VAZIO e o telefone escrito
// formatado ("+55 (11) 91234-5678"). O .in() nao casa string formatada, entao
// normalizamos os dois lados em codigo com mesmoNumero.
//
// ISTO SEGURA 92% DA BASE DO VENDEDOR 8 (7.032 de 7.596 cards). Se falhar, nascem
// milhares de cards duplicados no primeiro dia.
//
// Duas precaucoes em relacao ao webhook Z-API, que NAO mudam a comparacao:
// 1) Varredura PAGINADA por range(). Sem isto o PostgREST devolve so o primeiro
//    lote (limite padrao de linhas) e os cards mais antigos ficariam invisiveis.
// 2) A varredura baixa so id e telefone. Baixar as 15 colunas de 7 mil cards a
//    cada mensagem traria megabytes por chamada. Achado o card, ele e relido
//    inteiro por id, entao o resto do fluxo recebe exatamente o mesmo objeto.
// A ordem (created_at desc, primeiro que casar vence) e identica a da funcao antiga.
async function buscarCardCaminhoLegado(
  supabase: Supa,
  vendedorId: string,
  variantesSet: Set<string>,
): Promise<any | null> {
  const LOTE = 1000;
  const MAX_LOTES = 50; // teto de seguranca: 50 mil cards por vendedor
  for (let lote = 0; lote < MAX_LOTES; lote++) {
    const de = lote * LOTE;
    const { data, error } = await supabase
      .from("clientes_crm")
      .select("id, telefone")
      .eq("vendedor_id", vendedorId)
      .is("mesclado_para", null)
      .is("numero_whatsapp", null)
      .order("created_at", { ascending: false })
      .range(de, de + LOTE - 1);
    if (error) {
      console.error("[ic-meta-webhook] caminho legado falhou:", error.message);
      return null;
    }
    if (!data || data.length === 0) return null;
    for (const c of data as any[]) {
      if (mesmoNumero(c.telefone || "", variantesSet)) {
        const { data: completo } = await supabase
          .from("clientes_crm")
          .select(SEL_CARD)
          .eq("id", c.id)
          .maybeSingle();
        return (completo as any) || null;
      }
    }
    if (data.length < LOTE) return null;
  }
  console.warn("[ic-meta-webhook] caminho legado atingiu o teto de lotes", { vendedorId });
  return null;
}

// (e) Caminho por chat_lid, mantido intacto para os cards antigos que dependem dele.
// A Meta nunca manda LID, entao em operacao normal ehLid() devolve false e este
// caminho fica dormente. Ele existe como rede de seguranca: se um identificador
// estranho chegar, o card e procurado pela correspondencia, e NUNCA se cria card.
// O caminho novo tambem nao GRAVA chat_lid (nao ha LID para guardar).
async function buscarCardPorChatLid(
  supabase: Supa,
  vendedorId: string,
  lid: string,
): Promise<any | null> {
  const { data } = await supabase
    .from("clientes_crm")
    .select(SEL_CARD)
    .eq("vendedor_id", vendedorId)
    .eq("chat_lid", lid)
    .is("mesclado_para", null)
    .order("deleted_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  return (data && data[0]) || null;
}

// Nome do lead. No Z-API vinha junto da mensagem (senderName). Na Meta vem no
// array irmao contacts[], casado pelo wa_id. O eco do vendedor NAO traz contacts,
// o que casa com a regra de que mensagem do vendedor nunca renomeia o card.
function nomeDoContato(value: any, waId: string): string {
  try {
    const lista = Array.isArray(value && value.contacts) ? value.contacts : [];
    const alvo = soDigitos(waId);
    for (const c of lista) {
      if (soDigitos(String(c.wa_id || "")) === alvo) {
        return String((c.profile && c.profile.name) || "").trim();
      }
    }
    // Um contato so e sem wa_id casando: aceita mesmo assim.
    if (lista.length === 1) {
      return String((lista[0].profile && lista[0].profile.name) || "").trim();
    }
  } catch (_e) { /* nome e opcional, nunca derruba a mensagem */ }
  return "";
}

// ===================================================================
// PROCESSAMENTO DE UMA MENSAGEM
// ===================================================================

// Trata UMA mensagem (a Meta pode mandar varias por chamada). Toda a regra de
// negocio do webhook Z-API vive aqui, com as adaptacoes de formato da Meta.
// ehEco = true quando veio de smb_message_echoes, ou seja, o vendedor mandou pelo
// celular. E o equivalente do fromMe do Z-API.
async function processarMensagem(
  supabase: Supa,
  vendedor: VendedorWa,
  m: any,
  value: any,
  ehEco: boolean,
  provedor: Provedor = "meta",
): Promise<Record<string, unknown>> {
  const fromMe = ehEco;
  // Vai em payload_raw.fonte e decide a origem em crm_entrada_falhas.
  const fonte: string = provedor;
  // (f) DIFERENCA CRITICA: no messages[] normal o "from" e o LEAD. No eco, "from" e
  // a empresa e o lead esta em "to". Tratar os dois iguais criaria card com o
  // proprio numero do vendedor.
  const phoneRaw: string = String((ehEco ? m.to : m.from) || "").trim();
  // (i) A Meta identifica a mensagem pelo wamid. Vai no mesmo campo zapi_message_id
  // para a trava anti-duplicata continuar funcionando sem tocar no banco.
  const messageId: string | null = m && m.id ? String(m.id) : null;

  if (!phoneRaw) return { ignored: "no phone" };

  const conteudo = extrairConteudoMeta(m);
  const tipo: string = conteudo.tipo;
  // texto = conteudo textual base (heuristica de campanha etc). Para audio fica vazio
  // aqui; a transcricao entra logo abaixo. Para 'outro' nao vaza o placeholder.
  let texto: string = tipo === "outro" ? "" : conteudo.mensagem;
  if (tipo === "outro") {
    console.log("[ic-meta-webhook] tipo 'outro' - type da Meta:", JSON.stringify(m && m.type));
  }
  const senderName: string = ehEco ? "" : nomeDoContato(value, phoneRaw);

  // (g) MIDIA e AUDIO. A Meta manda so o id: baixamos aqui, dentro do webhook.
  // AUDIO: transcricao via Groq nos DOIS lados (lead e vendedor), como hoje.
  // Falha suave em qualquer etapa: grava o placeholder e o webhook segue.
  let mensagemFinal: string = conteudo.mensagem;
  if (tipo === "audio") {
    // IC CRM: a transcricao fica atras da flag ia_transcricao_audio (cache de
    // 60 s em _shared/flags.ts). Desligada: nao baixa nem transcreve, grava o
    // placeholder atual. Ligada: baixa e transcreve.
    const transcreverLigado = await icFlag(supabase, "ia_transcricao_audio");
    if (!transcreverLigado) {
      console.log("[ic-meta-webhook] transcricao desligada por flag; audio gravado com placeholder");
    }
    const arq = transcreverLigado ? await baixarAudio(provedor, vendedor, m.audio || {}) : null;
    const transcricao = arq ? await transcreverAudioGroq(arq.bytes, arq.mimeType) : null;
    if (transcricao) {
      mensagemFinal = transcricao;
    } else {
      mensagemFinal = fromMe ? "[audio enviado]" : "[audio recebido - transcricao indisponivel]";
    }
  }

  // 2) Resolver o LEAD. Na Meta o telefone e sempre real, entao o fluxo normal e
  // o de telefone. ehLid so dispara em valor estranho (rede de seguranca).
  const phoneEhLid = ehLid(phoneRaw);
  const variantes = phoneEhLid ? [] : variacoesTelefone(phoneRaw);
  const canonico = phoneEhLid ? "" : canonicoTelefone(phoneRaw);
  const variantesSet = new Set(variantes);
  if (!phoneEhLid && variantes.length === 0) return { ignored: "phone invalido" };
  // Numero que esta em vendedores_whatsapp e da casa, nao e lead. Vendedor
  // conversando com vendedor ja criou card no pipeline; nao repete.
  if (canonico && numerosDaCasa.has(canonico)) {
    console.log("[ic-meta-webhook] numero da casa, nao vira card:", canonico);
    return { ignored: "numero de vendedor" };
  }

  let clienteExistente: any = null;
  if (phoneEhLid) {
    clienteExistente = await buscarCardPorChatLid(supabase, vendedor.vendedor_id, phoneRaw);
  } else {
    // BUSCA EM TRES CAMINHOS: rapido, legado, e telefone normalizado no funil.
    // O terceiro fecha a porta por onde os duplicados entravam: card cujo
    // numero_whatsapp esta vazio E cujo telefone escrito nao casou no legado.
    clienteExistente = await buscarCardCaminhoRapido(supabase, vendedor.vendedor_id, variantes);
    if (!clienteExistente) {
      clienteExistente = await buscarCardCaminhoLegado(supabase, vendedor.vendedor_id, variantesSet);
    }
    if (!clienteExistente) {
      clienteExistente = await buscarCardPorTelefoneNorm(supabase, vendedor.funil_id || null, canonico);
      if (clienteExistente) console.log("[ic-meta-webhook] card achado por telefone_norm no funil:", clienteExistente.id);
    }
  }

  // REGRA DE SEGURANCA: so cria card com telefone brasileiro plausivel (12 ou 13
  // digitos, 55...) e NUNCA com identificador estranho. Card errado e pior do que
  // nao criar.
  const podeCriarCard = !phoneEhLid && telefoneBrPlausivel(canonico);

  // Detectar campanha (heuristica basica: menciona 'anuncio' ou tem URL). So em RECEBIDA.
  let campanhaOrigemNova: string | null = null;
  if (!fromMe && ehMensagemDeCampanha(texto)) {
    campanhaOrigemNova = String(texto).slice(0, 500);
  }
  // (h) Anuncio e clique. So em RECEBIDA e so quando source_type for "ad".
  const ctwaTokenNovo: string | null = fromMe ? null : extrairCtwaClid(m);
  const anuncioNovo: DadosAnuncio | null = fromMe ? null : extrairAnuncioMeta(m);
  // (h2) Marcador do Google no texto pre-preenchido do link.
  const marcaGoogle = fromMe ? null : extrairMarcaGoogle(texto);
  if (marcaGoogle) {
    texto = marcaGoogle.limpo || texto;
    console.log("[ic-meta-webhook] marca do Google lida:", marcaGoogle.campanhaId);
  }

  const agoraIso = new Date().toISOString();
  let clienteId: string | null = null;
  let ehLeadNovoCriado = false;
  let foiReativado = false;
  let etapaInicialUsada: string | null = null;
  let migrouNumeroWhatsapp = false;
  // numero_lead da conversa: SEMPRE o telefone real.
  let numeroLeadConversa: string = canonico;

  if (clienteExistente) {
    clienteId = clienteExistente.id;
    if (phoneEhLid) {
      numeroLeadConversa = String(
        clienteExistente.numero_whatsapp ||
        canonicoTelefone(clienteExistente.telefone || "") ||
        clienteExistente.telefone || "",
      );
    }
    const etapaAtual = String(clienteExistente.etapa || "").toLowerCase();

    const upd: Record<string, unknown> = {
      ultima_mensagem_em: agoraIso,
      ultima_mensagem_direcao: fromMe ? "enviada" : "recebida",
    };
    // MIGRACAO PROGRESSIVA DA BASE: card achado pelo caminho legado (numero_whatsapp
    // vazio) ganha o canonico agora. Na proxima mensagem ele ja cai no caminho
    // rapido, e a varredura de 7 mil cards vai encolhendo sozinha.
    if (!clienteExistente.numero_whatsapp && !phoneEhLid) {
      upd.numero_whatsapp = canonico;
      migrouNumeroWhatsapp = true;
    }
    if (!fromMe && !clienteExistente.lead_chegou_em) upd.lead_chegou_em = agoraIso;
    if (fromMe && !clienteExistente.primeira_resposta_em) upd.primeira_resposta_em = agoraIso;

    // (e) chat_lid NAO e gravado aqui: a Meta nao tem LID. A coluna segue existindo
    // e servindo aos cards antigos.

    // REGRA 3: card "Sem nome" (ou vazio) + nome real do contato -> corrige o nome.
    // Guard fromMe: o eco nao traz contacts, e nome de vendedor nao renomeia o lead.
    const nomeAtual = String(clienteExistente.nome || "").trim();
    const pushNomeExist = (!fromMe && senderName) ? String(senderName).trim() : "";
    const semNome = !nomeAtual || /^sem\s*nome/i.test(nomeAtual);
    if (pushNomeExist && semNome) {
      const ult4Nome = String(clienteExistente.numero_whatsapp || canonico || "").slice(-4);
      upd.nome = `${pushNomeExist} ${ult4Nome}`;
    }

    // REGRA 1: lead existente SO sobe na coluna atual (o bump de ultima_mensagem_em
    // acima ja leva o card ao topo da coluna onde ele JA esta). NAO muda de etapa.
    // Reativacao: card soft-deleted volta a aparecer, MAS permanece na mesma coluna.
    if (clienteExistente.deleted_at) {
      upd.deleted_at = null;
      upd.deleted_by_user_id = null;
      upd.delete_reason = null;
      foiReativado = true;
    }
    if (!fromMe && campanhaOrigemNova && !clienteExistente.campanha_origem) {
      upd.campanha_origem = campanhaOrigemNova;
    }
    // ctwa_token e anuncio_* NUNCA sao sobrescritos: vale o primeiro anuncio que
    // trouxe o lead.
    if (!fromMe && ctwaTokenNovo && !clienteExistente.ctwa_token) {
      upd.ctwa_token = ctwaTokenNovo;
    }
    if (!fromMe && marcaGoogle && !clienteExistente.google_campanha_id) {
      upd.google_campanha_id = marcaGoogle.campanhaId;
      upd.google_gclid = marcaGoogle.gclid;
    }
    if (!fromMe && anuncioNovo && !clienteExistente.anuncio_id) {
      upd.anuncio_id = anuncioNovo.id;
      upd.anuncio_titulo = anuncioNovo.titulo;
      upd.anuncio_texto = anuncioNovo.texto;
      upd.anuncio_link = anuncioNovo.link;
      upd.anuncio_app = anuncioNovo.app;
    }

    const { error: errUpd } = await supabase
      .from("clientes_crm")
      .update(upd)
      .eq("id", clienteExistente.id);
    if (errUpd) {
      console.error("[ic-meta-webhook] update clientes_crm falhou:", errUpd);
    }

    if (foiReativado) {
      try {
        await supabase.from("crm_historico").insert({
          cliente_id: clienteId,
          tipo: "reativacao",
          etapa_anterior: etapaAtual,
          etapa_nova: etapaAtual,
          usuario_nome: "bot",
          descricao: "Card estava apagado (soft-delete). Reativado por nova mensagem no whatsapp. Permanece na coluna \"" + etapaAtual + "\".",
        });
      } catch (e) {
        console.warn("[ic-meta-webhook] crm_historico (reativacao) falhou:", e);
      }
    }
  } else if (podeCriarCard) {
    // Criar novo card na PRIMEIRA COLUNA REAL do funil do vendedor.
    if (!vendedor.funil_id) {
      console.warn("[ic-meta-webhook] vendedor sem funil_id cadastrado:", vendedor.vendedor_id);
    }
    const etapaInicial = await descobrirPrimeiraEtapa(supabase, vendedor.funil_id);
    etapaInicialUsada = etapaInicial;

    // REGRA 2: nome = nome do contato + 4 ultimos digitos (so exibicao).
    // Sem nome: "Sem nome" + 4 digitos. Os 4 digitos NAO sao chave de reconhecimento.
    const ult4 = canonico.slice(-4);
    const pushNome = (!fromMe && senderName) ? String(senderName).trim() : "";
    const nomeLead = pushNome ? `${pushNome} ${ult4}` : `Sem nome ${ult4}`;
    const insertPayload: Record<string, unknown> = {
      nome: nomeLead,
      telefone: canonico,
      numero_whatsapp: canonico,
      etapa: etapaInicial,
      vendedor_id: vendedor.vendedor_id,
      vendedor_nome: vendedor.vendedor_nome || null,
      origem: "whatsapp",
    };
    if (vendedor.funil_id) insertPayload.funil_id = vendedor.funil_id;
    if (campanhaOrigemNova) insertPayload.campanha_origem = campanhaOrigemNova;
    if (ctwaTokenNovo) insertPayload.ctwa_token = ctwaTokenNovo;
    if (marcaGoogle) {
      insertPayload.google_campanha_id = marcaGoogle.campanhaId;
      insertPayload.google_gclid = marcaGoogle.gclid;
      insertPayload.origem = "Google Ads";
    }
    if (anuncioNovo) {
      insertPayload.anuncio_id = anuncioNovo.id;
      insertPayload.anuncio_titulo = anuncioNovo.titulo;
      insertPayload.anuncio_texto = anuncioNovo.texto;
      insertPayload.anuncio_link = anuncioNovo.link;
      insertPayload.anuncio_app = anuncioNovo.app;
    }
    if (!fromMe) insertPayload.lead_chegou_em = agoraIso;
    insertPayload.ultima_mensagem_em = agoraIso;
    insertPayload.ultima_mensagem_direcao = fromMe ? "enviada" : "recebida";
    if (fromMe) insertPayload.primeira_resposta_em = agoraIso;

    const { data: novo, error: errIns } = await supabase
      .from("clientes_crm")
      .insert(insertPayload)
      .select("id")
      .single();
    if (errIns) {
      if (!ehColisaoUnicidade(errIns)) {
        await registrarFalhaEntrada(supabase, {
          etapa: "card",
          telefone: canonico,
          funil_id: vendedor.funil_id,
          vendedor_id: vendedor.vendedor_id,
          motivo: "insert de clientes_crm falhou",
          erro: errIns,
          payload: { fonte, message: m, metadata: value && value.metadata },
        });
        console.error("[ic-meta-webhook] insert clientes_crm falhou:", errIns);
        return { error: errIns.message };
      }

      // COLISAO: outro processo criou o card desta pessoa neste funil entre a
      // busca e o insert. Segue com o card que ganhou a corrida em vez de
      // abandonar a mensagem. Decisao ja tomada: reentrada de lead atualiza o
      // card antigo, e no mesmo funil nao pode haver dois da mesma pessoa.
      const idExistente = await cardVivoNoFunil(supabase, canonico, vendedor.funil_id);

      if (!idExistente) {
        // Colidiu e na releitura nao aparece card nenhum. Nao inventa caminho:
        // registra com o motivo nomeado.
        await registrarFalhaEntrada(supabase, {
          etapa: "card",
          telefone: canonico,
          funil_id: vendedor.funil_id,
          vendedor_id: vendedor.vendedor_id,
          motivo: "colisao de unicidade sem card visivel na releitura",
          erro: errIns,
          payload: { fonte, message: m, metadata: value && value.metadata },
        });
        console.error("[ic-meta-webhook] colisao sem card na releitura:", errIns);
        return { error: errIns.message };
      }

      const { data: cardDono } = await supabase
        .from("clientes_crm")
        .select("id, vendedor_id, lead_chegou_em, primeira_resposta_em")
        .eq("id", idExistente)
        .maybeSingle();

      const donoOutro = cardDono &&
        (cardDono as any).vendedor_id &&
        (cardDono as any).vendedor_id !== vendedor.vendedor_id;

      if (donoOutro) {
        // O card vivo deste telefone neste funil e de OUTRO vendedor. Jogar a
        // conversa dentro do card de um colega seria silencioso e errado. A
        // mensagem e gravada sem card, como ja acontece com LID sem
        // correspondencia, e a falha fica registrada com nome.
        await registrarFalhaEntrada(supabase, {
          etapa: "colisao_outro_vendedor",
          telefone: canonico,
          funil_id: vendedor.funil_id,
          vendedor_id: vendedor.vendedor_id,
          motivo: "card vivo deste telefone no funil pertence ao vendedor " +
            String((cardDono as any).vendedor_id),
          erro: errIns,
          payload: { fonte, message: m, metadata: value && value.metadata },
        });
        clienteId = null;
        numeroLeadConversa = canonico;
      } else {
        clienteId = idExistente;
        const updColisao: Record<string, unknown> = {
          ultima_mensagem_em: agoraIso,
          ultima_mensagem_direcao: fromMe ? "enviada" : "recebida",
          updated_at: agoraIso,
        };
        if (!fromMe && cardDono && !(cardDono as any).lead_chegou_em) {
          updColisao.lead_chegou_em = agoraIso;
        }
        if (fromMe && cardDono && !(cardDono as any).primeira_resposta_em) {
          updColisao.primeira_resposta_em = agoraIso;
        }
        const { error: errBump } = await supabase
          .from("clientes_crm")
          .update(updColisao)
          .eq("id", clienteId);
        if (errBump) {
          await registrarFalhaEntrada(supabase, {
            etapa: "card",
            telefone: canonico,
            funil_id: vendedor.funil_id,
            vendedor_id: vendedor.vendedor_id,
            motivo: "bump do card apos colisao falhou",
            erro: errBump,
            payload: { fonte, message: m, metadata: value && value.metadata },
          });
        }
        console.log("[ic-meta-webhook] colisao tratada, segue no card existente:", clienteId);
      }
    } else {
      clienteId = (novo as any).id;
      ehLeadNovoCriado = true;
    }
  } else {
    // NAO criar card: identificador estranho ou numero implausivel. A mensagem e
    // gravada em crm_conversas SEM card, para reconciliar depois com autorizacao.
    clienteId = null;
    numeroLeadConversa = phoneRaw || "";
    console.log(
      "[ic-meta-webhook] mensagem SEM card (nao criar):",
      JSON.stringify({ fromMe, phoneEhLid, phone: phoneRaw }),
    );
  }

  // 4) Gravar mensagem em crm_conversas.
  // DEDUP: quando o SISTEMA envia (via ic-whatsapp-send) ele ja grava a conversa E
  // manda a mensagem. Se a Meta devolver a mesma mensagem no eco, sem esta trava
  // apareceria uma bolha duplicada. Se o wamid ja existe, nao insere de novo.
  // REGRA DURA: nunca gravar mensagem null/vazia/so espacos. Calculada antes
  // da checagem de repeticao porque a copia pode trazer o texto que o
  // placeholder gravado nao tem.
  const mensagemGravar = (mensagemFinal || "").trim() || placeholderPorTipo(tipo);

  // Mesma mensagem, mesma instancia: e o mesmo criterio do indice unico. So o
  // id deixaria de fora a mensagem entre dois vendedores da casa, que chega nas
  // duas instancias com o mesmo id e e legitima nas duas.
  if (messageId) {
    const { data: jaExiste } = await supabase
      .from("crm_conversas")
      .select("id")
      .eq("zapi_message_id", messageId)
      .eq("vendedor_id", vendedor.vendedor_id)
      .limit(1);
    if (jaExiste && jaExiste.length) {
      await tratarConversaRepetida(supabase, {
        messageId,
        vendedorId: vendedor.vendedor_id,
        clienteId,
        tipo,
        mensagem: mensagemGravar,
        payloadRaw: { fonte, eco: ehEco, metadata: value && value.metadata, message: m },
      });
      return {
        cliente_id: clienteId,
        criado: ehLeadNovoCriado,
        reativado: foiReativado,
        duplicada: true,
        wamid: messageId,
      };
    }
  }


  // IC CRM: no ECO (fromMe) a linha nasce com autor 'vendedor'. E essa linha que
  // ic-ia-pre-atendimento le como "humano assumiu" (etapa humano_assumiu): a IA
  // fica calada por 24 h depois que alguem da equipe respondeu pelo celular.
  const { data: convNova, error: errConv } = await supabase.from("crm_conversas").insert({
    cliente_crm_id: clienteId,
    vendedor_id: vendedor.vendedor_id,
    numero_lead: numeroLeadConversa,
    direcao: fromMe ? "enviada" : "recebida",
    autor: fromMe ? "vendedor" : "lead",
    mensagem: mensagemGravar,
    tipo: tipo,
    zapi_message_id: messageId,
    // Diagnostico: guarda a mensagem crua da Meta e o contexto minimo. Nao vai pra tela.
    payload_raw: { fonte, eco: ehEco, metadata: value && value.metadata, message: m },
  }).select("id").maybeSingle();
  let conversaGravada = false;
  if (errConv && ehColisaoUnicidade(errConv)) {
    // Perdeu a corrida para outra entrega da mesma mensagem, ou e reenvio do
    // provedor. Nao e erro: reconhece, conta, e devolve sucesso.
    await tratarConversaRepetida(supabase, {
      messageId: String(messageId),
      vendedorId: vendedor.vendedor_id,
      clienteId,
      tipo,
      mensagem: mensagemGravar,
      payloadRaw: { fonte, eco: ehEco, metadata: value && value.metadata, message: m },
    });
  } else if (errConv) {
    console.error("[ic-meta-webhook] insert crm_conversas falhou:", errConv);
    // O card pode ter sido criado e a mensagem nao. Sem esta linha, a conversa
    // sumia em silencio.
    await registrarFalhaEntrada(supabase, {
      etapa: "conversa",
      telefone: canonico,
      funil_id: vendedor.funil_id,
      vendedor_id: vendedor.vendedor_id,
      motivo: "insert de crm_conversas falhou" + (clienteId ? " (card " + clienteId + ")" : " (sem card)"),
      erro: errConv,
      payload: { fonte, message: m, metadata: value && value.metadata },
    });
  } else {
    conversaGravada = true;
  }

  // IC CRM: GANCHO DA IA. So mensagem RECEBIDA do lead (nao eco), com card, que
  // foi gravada agora. Dispara em segundo plano e nunca espera nem propaga erro.
  if (!fromMe && clienteId && conversaGravada) {
    dispararIaPreAtendimento(supabase, {
      cliente_crm_id: clienteId,
      conversa_id: convNova && (convNova as any).id ? String((convNova as any).id) : null,
      vendedor_id: vendedor.vendedor_id,
      funil_id: vendedor.funil_id || null,
    });
  }

  return {
    cliente_id: clienteId,
    criado: ehLeadNovoCriado,
    etapa_inicial_usada: etapaInicialUsada,
    reativado: foiReativado,
    migrou_numero_whatsapp: migrouNumeroWhatsapp,
    canonico,
    tipo,
    direcao: fromMe ? "enviada" : "recebida",
    vendedor_id: vendedor.vendedor_id,
  };
}

// ===================================================================
// IC CRM: GANCHO DA IA DE PRE-ATENDIMENTO
// ===================================================================

// Chama ic-ia-pre-atendimento em segundo plano quando ic_flag('ia_pre_atendimento')
// esta ligada. Nao espera o resultado (EdgeRuntime.waitUntil) e engole qualquer
// erro: a IA e opcional, o webhook nao. Autorizacao pelo header x-ic-internal.
function dispararIaPreAtendimento(
  supabase: Supa,
  body: { cliente_crm_id: string; conversa_id: string | null; vendedor_id: string; funil_id: string | null },
): void {
  const trabalho = (async () => {
    try {
      const ligada = await icFlag(supabase, "ia_pre_atendimento");
      if (!ligada) return;
      const URL_SB = Deno.env.get("SUPABASE_URL") || "";
      const segredo = Deno.env.get("IC_INTERNAL_SECRET") || "";
      if (!URL_SB || !segredo) {
        console.warn("[ic-meta-webhook] IA ligada mas SUPABASE_URL/IC_INTERNAL_SECRET ausentes; gancho ignorado");
        return;
      }
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      const resp = await fetch(`${URL_SB}/functions/v1/ic-ia-pre-atendimento`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ic-internal": segredo,
          Authorization: "Bearer " + (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.warn("[ic-meta-webhook] ic-ia-pre-atendimento devolveu", resp.status, txt.slice(0, 200));
      } else {
        console.log("[ic-meta-webhook] IA disparada para o card", body.cliente_crm_id);
      }
    } catch (e) {
      console.warn("[ic-meta-webhook] gancho da IA falhou (ignorado):", e instanceof Error ? e.message : e);
    }
  })();
  const espera = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof espera === "function") espera.call((globalThis as any).EdgeRuntime, trabalho);
}

// ===================================================================
// ENTRADA
// ===================================================================

// Pega o que ficou parado e reprocessa. Cada linha conta a tentativa; passando
// do teto ela para de ser pega e fica visivel para sempre, com o motivo e o
// numero de tentativas - linha que desistiu nao pode virar silencio.
const VARREDOR_TETO = 5;
const VARREDOR_LOTE = 20;

async function varrerPendentes(URL_SB: string, SR: string): Promise<Record<string, unknown>> {
  const sb = createClient(URL_SB, SR, { auth: { persistSession: false } });
  const { data: linhas, error } = await sb
    .from("crm_entrada_bruta")
    .select("id, envelope, tentativas")
    .neq("estado", "processada")
    .lt("tentativas", VARREDOR_TETO)
    .order("chegou_em", { ascending: true })
    .limit(VARREDOR_LOTE);

  if (error) {
    console.error("[varredor] nao deu para ler as paradas:", error.message);
    return { ok: false, erro: error.message };
  }
  const pendentes = linhas || [];
  let ok = 0, falhou = 0;

  for (const linha of pendentes) {
    const tentativa = (Number(linha.tentativas) || 0) + 1;
    try {
      await processarPayload(URL_SB, SR, linha.envelope);
      await sb.from("crm_entrada_bruta")
        .update({ estado: "processada", motivo: null, tentativas: tentativa,
                  processada_em: new Date().toISOString() })
        .eq("id", linha.id);
      ok++;
    } catch (e) {
      const motivo: string = String((e as Error)?.message || e);
      await sb.from("crm_entrada_bruta")
        .update({ estado: "falhou", motivo: motivo.slice(0, 500), tentativas: tentativa })
        .eq("id", linha.id);
      falhou++;
      console.error("[varredor] entrada", linha.id, "tentativa", tentativa, ":", motivo);
    }
  }
  return { ok: true, pegas: pendentes.length, processadas: ok, falharam: falhou, teto: VARREDOR_TETO };
}

// Marca a linha do envelope cru depois que o processamento termina. Roda
// DEPOIS da resposta, entao nao atrasa nada. Se esta marcacao falhar, a linha
// fica 'pendente' - visivel como parada, que e melhor que mentir 'processada'.
async function marcarEntrada(
  sb: any,
  id: number | null,
  estado: "processada" | "falhou",
  motivo: string | null,
): Promise<void> {
  if (id == null) return;
  try {
    const { error } = await sb
      .from("crm_entrada_bruta")
      .update({ estado, motivo, processada_em: new Date().toISOString(), tentativas: 1 })
      .eq("id", id);
    if (error) console.error("[ic-meta-webhook] entrada", id, "nao marcada:", error.message);
  } catch (e) {
    console.error("[ic-meta-webhook] entrada", id, "nao marcada:", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Gupshup tem porta propria (token na URL em vez da assinatura da Meta).
  const urlReq = new URL(req.url);
  if (urlReq.searchParams.get("provedor") === "gupshup") return await entradaGupshup(req, urlReq);
  // (a) Verificacao de posse do endereco.
  if (req.method === "GET") return verificarWebhook(req);
  if (req.method !== "POST") return json({ ok: true, ignored: "method" });

  const URL_SB = Deno.env.get("SUPABASE_URL") || "";
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const APP_SECRET = Deno.env.get("META_APP_SECRET") || "";

  // -------------------------------------------------------------------
  // VARREDOR. O pg_cron chama aqui com {"varredor": true} e sem assinatura,
  // pelo mesmo caminho que os outros dois crons deste projeto usam: funcao
  // com verify_jwt=false e chave de servico vinda do proprio ambiente. Nao ha
  // credencial nova em lugar nenhum.
  //
  // Ele NAO e o caminho da mensagem. O caminho continua sendo o waitUntil, que
  // no dia medido processou 233 de 233. Isto aqui existe para o dia em que o
  // waitUntil morrer no meio: o envelope ja esta gravado, entao nada se perde,
  // so falta ser interpretado.
  //
  // Reprocessar e seguro porque e idempotente: a trava
  // crm_conversa_unica_por_instancia reconhece a mensagem repetida em vez de
  // duplicar. Por isso a chamada pode ser feita por qualquer um sem estrago:
  // o pior caso e reinterpretar envelope que ja esta no banco.
  // -------------------------------------------------------------------
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("json") && !req.headers.get("x-hub-signature-256")) {
      let talvez: any = null;
      try { talvez = await req.clone().json(); } catch (_e) { talvez = null; }
      if (talvez && talvez.varredor === true) {
        if (!URL_SB || !SR) return json({ ok: false, error: "env missing" }, 500);
        return json(await varrerPendentes(URL_SB, SR));
      }
    }
  }
  if (!URL_SB || !SR) {
    console.error("[ic-meta-webhook] SUPABASE_URL/SERVICE_ROLE ausentes");
    return json({ ok: true, error: "env missing" });
  }
  if (!APP_SECRET) {
    console.error("[ic-meta-webhook] META_APP_SECRET ausente; POST recusado");
    return json({ ok: true, error: "app secret missing" });
  }

  // (b) A assinatura e calculada sobre os BYTES CRUS. Por isso lemos arrayBuffer
  // antes de qualquer conversao: reserializar o JSON daria assinatura diferente.
  const bruto = new Uint8Array(await req.arrayBuffer());
  const assinatura = req.headers.get("x-hub-signature-256") || "";
  if (!(await assinaturaValida(bruto, assinatura, APP_SECRET))) {
    console.warn("[ic-meta-webhook] assinatura invalida, payload descartado");
    return json({ ok: true, ignored: "assinatura invalida" });
  }

  let payload: any = {};
  try {
    payload = JSON.parse(new TextDecoder().decode(bruto));
  } catch (_e) {
    return json({ ok: true, ignored: "payload nao-json" });
  }
  console.log("[ic-meta-webhook] payload:", JSON.stringify(payload).slice(0, 600));

  // -------------------------------------------------------------------
  // O ENVELOPE CRU, ANTES DO ACK.
  //
  // E a UNICA coisa que acontece antes da resposta, e existe por um motivo
  // so: o que gravamos em crm_conversas.payload_raw e um recorte
  // ({eco, fonte, message, metadata}). O envelope entry[].changes[] se perde,
  // e campo novo que a Meta mandar amanha cai no chao. Aqui ele cai em algum
  // lugar.
  //
  // Se ESTA gravacao falhar, o webhook NAO devolve sucesso: e o unico caso em
  // que a mensagem realmente nao entrou, e a Meta reenviando e o desfecho
  // certo. Envelope repetido entra de proposito; a trava de mensagem repetida
  // vive no processamento, nao aqui.
  //
  // Custo medido: o insert custa 0,012 ms no banco; o que ele acrescenta e uma
  // ida e volta ate o banco, na mesma regiao.
  // -------------------------------------------------------------------
  const sbEntrada = createClient(URL_SB, SR, { auth: { persistSession: false } });
  let entradaId: number | null = null;
  try {
    const { data: ent, error: errEnt } = await sbEntrada
      .from("crm_entrada_bruta")
      .insert({ origem: "meta", envelope: payload })
      .select("id")
      .single();
    if (errEnt) throw new Error(errEnt.message);
    entradaId = ent && typeof ent.id === "number" ? ent.id : null;
  } catch (e) {
    console.error("[ic-meta-webhook] envelope cru NAO gravado:", e && (e as Error).message);
    return json({ ok: false, error: "entrada nao gravada" }, 500);
  }

  // ACK IMEDIATO. O 200 sai aqui, antes de encostar no banco. Antes o 200 so
  // vinha depois de processar tudo: com o banco sufocado a invocacao estourava
  // em 504, a Meta nao recebia confirmacao e a mensagem se perdia - foi assim
  // que 99 mensagens de 22 leads sumiram hoje entre 16h e 17h30, com 876
  // invocacoes em 504 contra 368 em 200. O trabalho continua depois da
  // resposta, via waitUntil; se o ambiente nao oferecer waitUntil, processa
  // solto mesmo, que ainda e melhor que segurar o ack.
  const trabalho = processarPayload(URL_SB, SR, payload)
    .then(() => marcarEntrada(sbEntrada, entradaId, "processada", null))
    .catch(async (e) => {
      // Falhar no processamento nao pode sumir: a linha fica visivel, com o
      // motivo e a tentativa contada. O envelope ja esta gravado, entao nada
      // se perde - so falta ser interpretado.
      await marcarEntrada(sbEntrada, entradaId, "falhou", (e && (e as Error).message) || String(e));
      console.error("[ic-meta-webhook] erro pos-ack:", e);
    });
  const espera = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof espera === "function") {
    espera.call((globalThis as any).EdgeRuntime, trabalho);
  }
  return json({ ok: true, ack: true, entrada: entradaId });
});

// -------------------------------------------------------------------
// ENTRADA DO GUPSHUP
//
// Mesmas garantias da porta da Meta: envelope gravado em crm_entrada_bruta
// ANTES do ack, ack imediato, processamento em segundo plano pelo mesmo
// processarPayload, falha visivel para o varredor.
//
// Autenticidade: o Gupshup nao documenta assinatura de webhook. O que segura
// e o segredo GUPSHUP_WEBHOOK_TOKEN na URL cadastrada no painel, comparado em
// tempo constante. Token errado ou segredo ausente: 200 sem processar (nao
// gravamos nada vindo de quem nao provou ser o Gupshup).
// GET e POST vazio respondem 200: o painel testa a URL ao cadastrar.
// -------------------------------------------------------------------
async function entradaGupshup(req: Request, url: URL): Promise<Response> {
  const LOGG = "[ic-meta-webhook][gupshup]";
  const segredo = Deno.env.get("GUPSHUP_WEBHOOK_TOKEN") || "";
  if (!segredo) {
    console.error(LOGG, "GUPSHUP_WEBHOOK_TOKEN ausente; chamada recusada");
    return json({ ok: true, ignored: "token nao configurado" });
  }
  if (!tokenWebhookValido(url.searchParams.get("token") || "", segredo)) {
    console.warn(LOGG, "token invalido, payload descartado");
    return json({ ok: true, ignored: "token invalido" });
  }
  if (req.method !== "POST") return json({ ok: true });

  const URL_SB = Deno.env.get("SUPABASE_URL") || "";
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!URL_SB || !SR) {
    console.error(LOGG, "SUPABASE_URL/SERVICE_ROLE ausentes");
    return json({ ok: true, error: "env missing" });
  }

  const texto = await req.text();
  if (!texto.trim()) return json({ ok: true, ignored: "corpo vazio" });
  let bruto: any = null;
  try {
    bruto = JSON.parse(texto);
  } catch (_e) {
    return json({ ok: true, ignored: "payload nao-json" });
  }
  const { envelope, tipo } = envelopeGupshup(bruto);
  console.log(LOGG, "evento:", tipo, JSON.stringify(bruto).slice(0, 400));

  const sbEntrada = createClient(URL_SB, SR, { auth: { persistSession: false } });
  let entradaId: number | null = null;
  try {
    const { data: ent, error: errEnt } = await sbEntrada
      .from("crm_entrada_bruta")
      .insert({ origem: "gupshup", envelope })
      .select("id")
      .single();
    if (errEnt) throw new Error(errEnt.message);
    entradaId = ent && typeof ent.id === "number" ? ent.id : null;
  } catch (e) {
    // Mesmo desfecho da Meta: sem envelope gravado, erro para o provedor reenviar.
    console.error(LOGG, "envelope cru NAO gravado:", e && (e as Error).message);
    return json({ ok: false, error: "entrada nao gravada" }, 500);
  }

  const trabalho = processarPayload(URL_SB, SR, envelope)
    .then(() => marcarEntrada(sbEntrada, entradaId, "processada", null))
    .catch(async (e) => {
      await marcarEntrada(sbEntrada, entradaId, "falhou", (e && (e as Error).message) || String(e));
      console.error(LOGG, "erro pos-ack:", e);
    });
  const espera = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof espera === "function") {
    espera.call((globalThis as any).EdgeRuntime, trabalho);
  }
  return json({ ok: true, ack: true, entrada: entradaId });
}

// Todo o processamento vive aqui, fora do caminho da resposta. Nada do que
// acontece daqui para baixo pode atrasar o ack da Meta.
// O envelope e sempre o da Meta; quando veio do Gupshup, traz _ic_provedor.
async function processarPayload(URL_SB: string, SR: string, payload: any): Promise<void> {
  const resultados: unknown[] = [];
  const provedor: Provedor = payload && payload._ic_provedor === "gupshup" ? "gupshup" : "meta";
  try {
    const supabase = createClient(URL_SB, SR, { auth: { persistSession: false } });
    const entries = Array.isArray(payload.entry) ? payload.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const field = String((change && change.field) || "");
        const value = (change && change.value) || {};

        // (j) LISTA BRANCA. history e smb_app_state_sync caem aqui e sao apenas
        // logados. Tratar historico como mensagem nova criaria milhares de cards
        // falsos; state_sync e a agenda do celular, e contato nao e lead.
        if (!CAMPOS_PROCESSADOS.has(field)) {
          console.log("[ic-meta-webhook] campo ignorado:", field);
          resultados.push({ field, ignored: "campo fora da lista branca" });
          continue;
        }
        // (k) Confirmacoes de entrega/leitura/reproducao: so log, nao gravam nada.
        if (Array.isArray(value.statuses) && value.statuses.length) {
          console.log(
            "[ic-meta-webhook] statuses ignorados:",
            JSON.stringify(value.statuses.map((s: any) => s && s.status)),
          );
          // Gupshup: o envio e assincrono, entao a recusa (ex.: 470 = fora da
          // janela de 24 h) so aparece aqui. Fica no log de erro com o id.
          for (const st of value.statuses) {
            if (provedor === "gupshup" && st && st.status === "failed") {
              console.error(
                "[ic-meta-webhook][gupshup] envio falhou:",
                JSON.stringify({ id: st.id, gs_id: st.gs_id, codigo: st.codigo, motivo: st.motivo, errors: st.errors }).slice(0, 500),
              );
            }
          }
          resultados.push({ field, ignored: "statuses" });
          continue;
        }
        // Guarda extra: mesmo dentro de um campo da lista branca, histórico ou
        // agenda nunca viram card.
        if (value.history || value.state_sync) {
          console.log("[ic-meta-webhook] history/state_sync dentro de", field, "- ignorado");
          resultados.push({ field, ignored: "history/state_sync" });
          continue;
        }

        const phoneNumberId = String((value.metadata && value.metadata.phone_number_id) || "");
        const { vendedor, erro: erroVendedor } = provedor === "gupshup"
          ? await acharVendedorGupshup(supabase, {
            appId: String(payload.gs_app_id || ""),
            phoneNumberId,
            appName: String(payload.gs_app_name || (value.metadata && value.metadata.gs_app_name) || ""),
            numeroCasa: String((value.metadata && value.metadata.display_phone_number) || ""),
          })
          : await acharVendedorPorPhoneId(supabase, phoneNumberId);
        if (erroVendedor) {
          // Nao e "sem vendedor": e a consulta que falhou. Sai como erro para
          // aparecer no log de erro e nao se disfarcar de cadastro faltando.
          console.error("[ic-meta-webhook] FALHA ao consultar vendedores_whatsapp:", erroVendedor, "phone_number_id:", phoneNumberId);
          resultados.push({ field, error: "lookup vendedor falhou", detalhe: erroVendedor, phone_number_id: phoneNumberId });
          continue;
        }
        if (!vendedor) {
          console.log("[ic-meta-webhook] numero sem vendedor ativo:", provedor, phoneNumberId || payload.gs_app_id || payload.gs_app_name || "");
          resultados.push({ field, ignored: "no vendor", phone_number_id: phoneNumberId });
          continue;
        }

        // (c) e (f) Um POST pode trazer varias mensagens: percorre todas.
        const ehEco = field === "smb_message_echoes";
        const lista = ehEco
          ? (Array.isArray(value.message_echoes) ? value.message_echoes : [])
          : (Array.isArray(value.messages) ? value.messages : []);
        if (!lista.length) {
          resultados.push({ field, ignored: "sem mensagens" });
          continue;
        }

        for (const m of lista) {
          // Uma mensagem com problema nao pode derrubar as outras do mesmo lote.
          try {
            resultados.push(await processarMensagem(supabase, vendedor, m, value, ehEco, provedor));
          } catch (e) {
            console.error("[ic-meta-webhook] erro na mensagem:", m && m.id, e);
            // Excecao no meio do caminho tambem e mensagem perdida.
            await registrarFalhaEntrada(supabase, {
              etapa: "excecao",
              telefone: String((m && (m.from || m.to)) || "") || null,
              funil_id: vendedor.funil_id,
              vendedor_id: vendedor.vendedor_id,
              motivo: "excecao ao processar a mensagem " + String((m && m.id) || "sem wamid"),
              erro: e,
              payload: { fonte: provedor, message: m, metadata: value && value.metadata },
            });
            resultados.push({ wamid: m && m.id, error: (e as Error).message || "unknown" });
          }
        }
      }
    }
  } catch (err) {
    console.error("[ic-meta-webhook] erro pos-ack:", err);
    return;
  }

  const comErro = resultados.filter((r: any) => r && r.error).length;
  if (comErro) {
    console.error("[ic-meta-webhook] processadas:", resultados.length, "com erro:", comErro, JSON.stringify(resultados).slice(0, 600));
  } else {
    console.log("[ic-meta-webhook] processadas:", resultados.length);
  }
}
