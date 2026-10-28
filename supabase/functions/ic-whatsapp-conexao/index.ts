// ic-whatsapp-conexao: status da conexao do WhatsApp (Z-API) e QR Code para
// reconectar, usados pela tela de reconexao do CRM (ic-extensoes.js, secao 9).
//
// Quem chama: o FRONT (usuario logado e ativo), via supabaseClient.functions.invoke.
// 'status' vale para todos (faixa de alerta); 'qrcode' so para Admin (quem le o
// QR assume o numero).
// Publicar: supabase functions deploy ic-whatsapp-conexao        (verify_jwt LIGADO)
//
// CONTRATO
//   POST { acao: 'status' }
//     200 { ok: true, linhas: [{ id, nome, numero, conectado, celular_online }], desconectado }
//         linha com erro ao consultar vem com conectado: null (nao abre a tela).
//   POST { acao: 'qrcode', linha_id }
//     200 { ok: true, imagem: 'data:image/png;base64,...' }
//     200 { ok: true, ja_conectado: true }
//     409 { ok: false, erro: 'chave_de_acesso' }   -> aparelho pede chave; conectar pelo painel da Z-API
//     502 { ok: false, erro: 'sem_qr' }
//     403 { ok: false, erro: 'somente_admin' }
//   400 { ok: false, erro: 'acao_invalida' | 'linha_invalida' }
//   401/403 { ok: false, erro: 'sem_token' | 'token_invalido' | 'usuario_inativo' | 'usuario_nao_cadastrado' }
//   404 { ok: false, erro: 'linha_nao_encontrada' }
//   503 { ok: false, erro: 'zapi_nao_configurada' }
//
// So linhas ativas com provedor 'zapi'. Tokens ficam nos segredos
// (ZAPI_INSTANCE_TOKEN, ZAPI_CLIENT_TOKEN) e nunca saem daqui.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, erroGenerico, json } from "../_shared/http.ts";
import { ehAdmin, usuarioAtivo } from "../_shared/auth.ts";
import { canalDaLinha, provedorDaLinha } from "../_shared/whatsapp-envio.ts";
import { qrCodeZapi, statusZapi } from "../_shared/zapi.ts";
import type { CanalZapi } from "../_shared/zapi.ts";

const LOG = "[ic-whatsapp-conexao]";
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canalZapi(linha: any): CanalZapi | null {
  const r = canalDaLinha(linha, (n) => Deno.env.get(n));
  return r.ok && r.canal.provedor === "zapi" ? r.canal : null;
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
    const sb = createClient(URL_SB, SR, { auth: { persistSession: false } });

    const auth = await usuarioAtivo(req, sb);
    if (!auth.ok) return json({ ok: false, erro: auth.erro }, auth.status);

    let payload: any = {};
    try {
      payload = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "acao_invalida" }, 400);
    }
    const acao = String((payload && payload.acao) || "");

    const { data: linhas, error } = await sb
      .from("vendedores_whatsapp")
      .select("id, vendedor_nome, numero_whatsapp, zapi_instancia, provedor, ativo")
      .eq("ativo", true);
    if (error) {
      console.error(LOG, "vendedores_whatsapp falhou:", error.message);
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    const zapi = ((linhas as any[]) || []).filter((l) => provedorDaLinha(l) === "zapi" && l.zapi_instancia);

    if (acao === "status") {
      const out = await Promise.all(zapi.map(async (l) => {
        const canal = canalZapi(l);
        const base = { id: String(l.id), nome: l.vendedor_nome || null, numero: l.numero_whatsapp || null };
        if (!canal) return { ...base, conectado: null, celular_online: null };
        const s = await statusZapi(canal, LOG);
        if (!s.ok) {
          console.warn(LOG, "status indisponivel:", s.status, s.detalhe);
          return { ...base, conectado: null, celular_online: null };
        }
        return { ...base, conectado: s.conectado, celular_online: s.celularOnline };
      }));
      return json({ ok: true, linhas: out, desconectado: out.some((l) => l.conectado === false) });
    }

    if (acao === "qrcode") {
      if (!ehAdmin(auth.usuario)) return json({ ok: false, erro: "somente_admin" }, 403);
      const linhaId = String((payload && payload.linha_id) || "");
      if (!RE_UUID.test(linhaId)) return json({ ok: false, erro: "linha_invalida" }, 400);
      const linha = zapi.find((l) => String(l.id) === linhaId);
      if (!linha) return json({ ok: false, erro: "linha_nao_encontrada" }, 404);
      const canal = canalZapi(linha);
      if (!canal) return json({ ok: false, erro: "zapi_nao_configurada" }, 503);
      const s = await statusZapi(canal, LOG);
      if (s.ok && s.conectado) return json({ ok: true, ja_conectado: true });
      const qr = await qrCodeZapi(canal, LOG);
      if (qr.ok) {
        console.log(LOG, "QR Code pedido pelo usuario", auth.usuario.id);
        return json({ ok: true, imagem: qr.imagem });
      }
      console.warn(LOG, "QR indisponivel:", qr.motivo, qr.detalhe);
      return json({ ok: false, erro: qr.motivo }, qr.motivo === "chave_de_acesso" ? 409 : 502);
    }

    return json({ ok: false, erro: "acao_invalida" }, 400);
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});
