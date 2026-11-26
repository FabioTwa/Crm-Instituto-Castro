// ic-supportclinic: recebe do robo do GitHub (workflow "Support Clinic -
// exportacao diaria") o relatorio de agendamentos do Support Clinic e grava no
// CRM; tambem avisa por WhatsApp quando o robo falha.
//
// Quem chama: SO o robo, com o header x-sc-token = SC_IMPORT_TOKEN (segredo
// proprio, diferente do IC_INTERNAL_SECRET, para o GitHub nao ter acesso a mais nada).
// Publicar: supabase functions deploy ic-supportclinic --no-verify-jwt
//   (o robo nao tem JWT do Supabase; a autorizacao e o x-sc-token).
//
// CONTRATO
//   POST {acao:'importar', periodo:{ini:'AAAA-MM-DD', fim:'AAAA-MM-DD'}, linhas:[
//          {codigo, telefone, data, tipo, profissional, agendado_por, status, criado}]}
//     -> public.ic_sc_importar (SQL 58): so linhas de cards do CRM ficam; move as etapas.
//     200 {ok, linhas, casados, movidos, voltaram} | {ok, ignorado:'importacao_desligada'}
//   POST {acao:'falha', etapa, motivo}
//     -> WhatsApp ao numero de crm_ia_config.sc_alerta_whatsapp (pelo numero Z-API ativo).
//     200 {ok, enviado}
//   401 {ok:false, erro:'nao_autorizado'}  400 {ok:false, erro:'payload_invalido'|...}
//
// LGPD: o nome do paciente nao e aceito (validarImportacao descarta). Nada de
// paciente vai para o log.
//
// VARIAVEIS DE AMBIENTE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (o Supabase injeta)
//   SC_IMPORT_TOKEN                          (mesmo valor do segredo do GitHub)
//   ZAPI_INSTANCE_TOKEN, ZAPI_CLIENT_TOKEN   (aviso de falha)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { erroGenerico, json } from "../_shared/http.ts";
import { iguaisTempoConstante } from "../_shared/crypto.ts";
import { canalDaLinha } from "../_shared/whatsapp-envio.ts";
import { enviarTextoZapi } from "../_shared/zapi.ts";
import { canonicoTelefone } from "../_shared/telefone.ts";
import { textoAlertaFalha, validarImportacao } from "../_shared/support-clinic.ts";

const LOG = "[ic-supportclinic]";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, erro: "metodo_nao_suportado" }, 405);

  const esperado = Deno.env.get("SC_IMPORT_TOKEN") || "";
  if (!esperado || esperado.length < 24 || !iguaisTempoConstante(req.headers.get("x-sc-token") || "", esperado)) {
    return json({ ok: false, erro: "nao_autorizado" }, 401);
  }

  try {
    const URL_SB = Deno.env.get("SUPABASE_URL") || "";
    const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!URL_SB || !SR) {
      console.error(LOG, "SUPABASE_URL/SERVICE_ROLE ausentes");
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    const sb = createClient(URL_SB, SR, { auth: { persistSession: false, autoRefreshToken: false } });

    let body: any = null;
    try {
      body = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "payload_invalido" }, 400);
    }

    if (body && body.acao === "falha") {
      const enviado = await avisarFalha(sb, body.etapa, body.motivo);
      console.warn(LOG, "robo informou falha na etapa", String(body.etapa || "").slice(0, 20), "aviso enviado:", enviado);
      return json({ ok: true, enviado });
    }

    if (!body || body.acao !== "importar") return json({ ok: false, erro: "payload_invalido" }, 400);
    const v = validarImportacao(body);
    if (!v.ok) return json({ ok: false, erro: v.erro }, 400);

    const { data, error } = await sb.rpc("ic_sc_importar", {
      p_ini: v.ini,
      p_fim: v.fim,
      p_linhas: v.linhas,
      p_origem: "robo",
    });
    if (error) {
      console.error(LOG, "ic_sc_importar falhou:", error.message);
      await avisarFalha(sb, "importacao", "o banco recusou a importação (" + error.message.slice(0, 120) + ")");
      return json({ ok: false, erro: "importacao_falhou" }, 500);
    }
    const r: any = data || {};
    console.log(LOG, "importacao:", JSON.stringify({ linhas: r.linhas, casados: r.casados, movidos: r.movidos, voltaram: r.voltaram, ignorado: r.ignorado }));
    return json({ ok: true, ...r });
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});

async function avisarFalha(sb: any, etapa: unknown, motivo: unknown): Promise<boolean> {
  const { data: cfg } = await sb.from("crm_ia_config").select("valor").eq("chave", "sc_alerta_whatsapp").maybeSingle();
  const para = canonicoTelefone(String((cfg && cfg.valor) || ""));
  if (!para) return false;
  const { data, error } = await sb.from("vendedores_whatsapp").select("*")
    .eq("ativo", true).eq("provedor", "zapi").not("zapi_instancia", "is", null)
    .order("created_at", { ascending: true }).limit(1);
  if (error) {
    console.error(LOG, "numero ilegivel:", error.message);
    return false;
  }
  const c = canalDaLinha((data as any[])?.[0] || null, (n) => Deno.env.get(n));
  if (!c.ok || c.canal.provedor !== "zapi") {
    console.error(LOG, "sem canal Z-API para o aviso");
    return false;
  }
  const r = await enviarTextoZapi({
    canal: { instancia: c.canal.instancia, token: c.canal.token, clientToken: c.canal.clientToken },
    para,
    texto: textoAlertaFalha(etapa, motivo, new Date()),
    prefixoLog: LOG,
  });
  return r.ok;
}
