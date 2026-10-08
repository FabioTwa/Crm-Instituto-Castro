// ic-whatsapp-send: envio de mensagem do CRM para o lead pelo WhatsApp, atras
// da feature flag envio_whatsapp_cloud_api (vale para os dois provedores).
// O provedor sai do numero do vendedor (vendedores_whatsapp.provedor):
// 'meta' = Cloud API direta; 'gupshup' = Gupshup (coexistencia). Ver
// _shared/whatsapp-envio.ts.
//
// Quem chama: o FRONT (usuario logado), via supabaseClient.functions.invoke.
// Publicar: supabase functions deploy ic-whatsapp-send        (verify_jwt LIGADO)
//
// CONTRATO
//   POST { cliente_crm_id, texto }                             -> texto livre (janela 24 h)
//   POST { cliente_crm_id, template: { name, language, components? } } -> modelo aprovado (Meta)
//   POST { cliente_crm_id, template: { id, params? } }         -> modelo aprovado (Gupshup: ID do modelo no painel)
//   200 { ok: true, conversa_id, criada_em, wamid, tipo: 'texto'|'template' }
//   400 { ok: false, erro: 'payload_invalido' | 'texto_invalido' | 'card_sem_numero' | ... }
//   401/403 { ok: false, erro: 'sem_token' | 'token_invalido' | 'usuario_inativo' | 'usuario_nao_cadastrado' }
//   403 { ok: false, erro: 'envio_desligado' }                 -> flag desligada
//   404 { ok: false, erro: 'card_nao_encontrado' | 'vendedor_sem_cloud_api' } -> numero sem provedor configurado
//   409 { ok: false, erro: 'fora_da_janela_24h' }              -> Meta 131047; use template
//   502 { ok: false, erro: 'meta_recusou' | 'gupshup_recusou' } -> provedor recusou (detalhe so no log)
//   503 { ok: false, erro: 'envio_nao_configurado' }           -> falta META_ACCESS_TOKEN / GUPSHUP_API_KEY
//
// GUPSHUP: o envio e assincrono. 200 aqui quer dizer que o Gupshup ACEITOU;
// falha posterior (ex.: fora da janela de 24 h) chega no webhook como
// message-event "failed" e fica no log. O id gravado em zapi_message_id e o
// messageId do Gupshup.
//   500 { ok: false, erro: 'erro_interno' }
//
// FLUXO (so grava DEPOIS da confirmacao do envio)
//   1. valida JWT + public.users ativo;
//   2. ic_flag('envio_whatsapp_cloud_api') false -> 403 envio_desligado;
//   3. carrega o card e o canal do vendedor_id do card (_shared/whatsapp-envio.ts);
//   4. valida texto (1-4096 chars) ou template;
//   5. envia pelo provedor do numero (Meta: Graph API; Gupshup: api.gupshup.io);
//   6. SO com a confirmacao do provedor: grava crm_conversas {direcao 'enviada', autor 'vendedor',
//      tipo 'texto', zapi_message_id = wamid, payload_raw = resposta da Meta} e
//      atualiza clientes_crm.ultima_mensagem_em / ultima_mensagem_direcao /
//      primeira_resposta_em (se nulo).
//
// DEDUP COM O ECO: a Meta devolve esta mesma mensagem ao ic-meta-webhook em
// smb_message_echoes com o MESMO wamid. O webhook procura zapi_message_id +
// vendedor_id antes de inserir (e o indice unico crm_conversa_unica_por_instancia
// segura a corrida), entao o eco e reconhecido como repetida e nao duplica a
// bolha. E por isso que o wamid vai em zapi_message_id, e nao em outro campo.
//
// VARIAVEIS DE AMBIENTE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (o Supabase injeta)
//   META_ACCESS_TOKEN   token permanente do usuario do sistema (whatsapp_business_messaging), provedor 'meta'
//   GUPSHUP_API_KEY     API key da conta do Gupshup, provedor 'gupshup'
//   IC_INTERNAL_SECRET  (lido por _shared/auth.ts; aqui nao e usado para autorizar)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, erroGenerico, json } from "../_shared/http.ts";
import { usuarioAtivo } from "../_shared/auth.ts";
import { icFlag } from "../_shared/flags.ts";
import { canonicoTelefone, telefoneBrPlausivel } from "../_shared/telefone.ts";
import type { ResultadoEnvio } from "../_shared/whatsapp-cloud.ts";
import { canalDoVendedor, enviarModeloCanal, enviarTextoCanal, modeloValido } from "../_shared/whatsapp-envio.ts";

const LOG = "[ic-whatsapp-send]";
const MAX_TEXTO = 4096;

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
    const sb = createClient(URL_SB, SR, { auth: { persistSession: false } });

    // 1) Usuario logado e ativo em public.users.
    const auth = await usuarioAtivo(req, sb);
    if (!auth.ok) return json({ ok: false, erro: auth.erro }, auth.status);

    // 2) Feature flag.
    if (!(await icFlag(sb, "envio_whatsapp_cloud_api"))) {
      return json({ ok: false, erro: "envio_desligado" }, 403);
    }

    let payload: any = {};
    try {
      payload = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "payload_invalido" }, 400);
    }
    const clienteId = String(payload.cliente_crm_id || "").trim();
    if (!clienteId) return json({ ok: false, erro: "payload_invalido" }, 400);

    const texto = payload.texto != null ? String(payload.texto).trim() : "";
    const template = payload.template && typeof payload.template === "object" ? payload.template : null;
    if (!template) {
      if (!texto || texto.length > MAX_TEXTO) return json({ ok: false, erro: "texto_invalido" }, 400);
    }

    // 3) Card e numero do vendedor na Cloud API.
    const { data: card, error: errCard } = await sb
      .from("clientes_crm")
      .select("id, nome, numero_whatsapp, telefone, vendedor_id, primeira_resposta_em, deleted_at")
      .eq("id", clienteId)
      .maybeSingle();
    if (errCard) {
      console.error(LOG, "erro ao buscar card:", errCard.message);
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    if (!card) return json({ ok: false, erro: "card_nao_encontrado" }, 404);

    const para = canonicoTelefone(String((card as any).numero_whatsapp || (card as any).telefone || ""));
    if (!telefoneBrPlausivel(para)) return json({ ok: false, erro: "card_sem_numero" }, 400);

    const vendedorId = (card as any).vendedor_id ? String((card as any).vendedor_id) : "";
    if (!vendedorId) return json({ ok: false, erro: "card_sem_vendedor" }, 400);

    const res = await canalDoVendedor(sb, vendedorId);
    if (!res.ok) {
      if (res.erroBanco) {
        console.error(LOG, "erro ao buscar vendedores_whatsapp:", res.erroBanco);
        return json({ ok: false, erro: "erro_interno" }, 500);
      }
      if (res.motivo === "sem_credencial") {
        console.error(LOG, "credencial ausente para o provedor", res.provedor);
        return json({ ok: false, erro: "envio_nao_configurado" }, 503);
      }
      return json({ ok: false, erro: "vendedor_sem_cloud_api" }, 404);
    }
    const canal = res.canal;
    if (template && !modeloValido(canal, template)) return json({ ok: false, erro: "template_invalido" }, 400);

    // 4) Envio. Nada e gravado antes da confirmacao.
    let envio: ResultadoEnvio;
    let tipoEnvio: "texto" | "template";
    let mensagemGravar: string;
    if (template) {
      tipoEnvio = "template";
      envio = await enviarModeloCanal(canal, para, template, LOG);
      mensagemGravar = "[Modelo enviado] " + String(canal.provedor === "gupshup" ? template.id : template.name);
    } else {
      tipoEnvio = "texto";
      envio = await enviarTextoCanal(canal, para, texto, LOG);
      mensagemGravar = texto;
    }

    if (!envio.ok) {
      if (envio.foraDaJanela24h) return json({ ok: false, erro: "fora_da_janela_24h" }, 409);
      return json({ ok: false, erro: canal.provedor === "gupshup" ? "gupshup_recusou" : "meta_recusou" }, 502);
    }

    // 5) Confirmado: grava a conversa e atualiza o card.
    const agoraIso = new Date().toISOString();
    const { data: conv, error: errConv } = await sb
      .from("crm_conversas")
      .insert({
        cliente_crm_id: clienteId,
        vendedor_id: vendedorId,
        numero_lead: para,
        direcao: "enviada",
        autor: "vendedor",
        mensagem: mensagemGravar,
        tipo: "texto",
        zapi_message_id: envio.wamid,
        criada_em: agoraIso,
        payload_raw: {
          fonte: "ic-whatsapp-send",
          provedor: canal.provedor,
          tipo_envio: tipoEnvio,
          enviado_por: auth.usuario.id,
          meta: envio.resposta,
          ...(template
            ? {
              template: canal.provedor === "gupshup"
                ? { id: template.id }
                : { name: template.name, language: template.language || "pt_BR" },
            }
            : {}),
        },
      })
      .select("id, criada_em")
      .maybeSingle();
    if (errConv) {
      // A mensagem JA saiu. Na Meta o eco grava a bolha pelo webhook; avisa o front.
      console.error(LOG, "insert crm_conversas falhou (mensagem ja enviada):", errConv.message);
      return json({ ok: true, conversa_id: null, criada_em: agoraIso, wamid: envio.wamid, tipo: tipoEnvio, aviso: "enviada_sem_registro" });
    }

    const upd: Record<string, unknown> = { ultima_mensagem_em: agoraIso, ultima_mensagem_direcao: "enviada" };
    if (!(card as any).primeira_resposta_em) upd.primeira_resposta_em = agoraIso;
    const { error: errUpd } = await sb.from("clientes_crm").update(upd).eq("id", clienteId);
    if (errUpd) console.error(LOG, "update clientes_crm falhou:", errUpd.message);

    return json({
      ok: true,
      conversa_id: conv ? (conv as any).id : null,
      criada_em: conv ? (conv as any).criada_em : agoraIso,
      wamid: envio.wamid,
      tipo: tipoEnvio,
    });
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});
