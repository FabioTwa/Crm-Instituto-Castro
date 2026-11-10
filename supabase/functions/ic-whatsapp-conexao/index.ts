// ic-whatsapp-conexao: estado da conexao do WhatsApp (Z-API), QR Code para
// reconectar e a tela Sistema > WhatsApp (ic-extensoes.js, secao 9).
//
// Quem chama: o FRONT (usuario logado e ativo), via supabaseClient.functions.invoke.
// 'status' vale para todos (faixa de alerta); o resto so para Admin (quem le o
// QR assume o numero; desconectar derruba a Jully).
// Publicar: supabase functions deploy ic-whatsapp-conexao        (verify_jwt LIGADO)
//
// ESTADO (SQL 48): vendedores_whatsapp.zapi_estado guarda o ultimo estado
// conhecido. Ele muda por 3 caminhos, todos pela funcao do banco
// ic_whatsapp_registrar_estado (so registra no historico quando MUDA):
//   1) aviso da Z-API (ic-meta-webhook, "Ao conectar"/"Ao desconectar"): na hora;
//   2) conferencia: 'status' le o banco e so pergunta a Z-API se a ultima
//      conferencia tem mais de 60 s (ic_whatsapp_reservar_conferencia), entao
//      varias abas abertas nao multiplicam as chamadas;
//   3) a tela: Testar conexao, Desconectar e a conferencia durante o QR.
//
// CONTRATO
//   POST { acao: 'status', forcar?: true }          forcar so vale para Admin
//     200 { ok: true, linhas: [{ id, nome, numero, conectado, celular_online, desde, conferido_em }], desconectado }
//         conectado: null = ainda nao se sabe (nao abre a tela nem a faixa).
//   POST { acao: 'qrcode', linha_id }               Admin
//     200 { ok: true, imagem: 'data:image/png;base64,...' } | { ok: true, ja_conectado: true }
//     409 { ok: false, erro: 'chave_de_acesso' }   -> aparelho pede chave; conectar pelo painel da Z-API
//     502 { ok: false, erro: 'sem_qr' }
//   POST { acao: 'testar', linha_id }               Admin
//     200 { ok: true, conectado, celular_online, avisos: 'ok' | 'falhou' | 'sem_segredo' }
//         confere agora na Z-API e (re)aponta os avisos "Ao conectar" e
//         "Ao desconectar" para o ic-meta-webhook (o aviso de mensagens nao e tocado).
//     502 { ok: false, erro: 'zapi_indisponivel', detalhe }
//   POST { acao: 'desconectar', linha_id }          Admin
//     200 { ok: true }  |  502 { ok: false, erro: 'zapi_recusou', conectado }
//   POST { acao: 'historico' }                      Admin
//     200 { ok: true, eventos: [{ id, linha_id, numero, estado, origem, quando, usuario, fora_ms }] }
//   400 { ok: false, erro: 'acao_invalida' | 'linha_invalida' }
//   401/403 { ok: false, erro: 'sem_token' | 'token_invalido' | 'usuario_inativo' | 'usuario_nao_cadastrado' | 'somente_admin' }
//   404 { ok: false, erro: 'linha_nao_encontrada' }
//   503 { ok: false, erro: 'zapi_nao_configurada' }
//
// So linhas ativas com provedor 'zapi'. Tokens ficam nos segredos
// (ZAPI_INSTANCE_TOKEN, ZAPI_CLIENT_TOKEN, ZAPI_WEBHOOK_TOKEN) e nunca saem daqui.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, erroGenerico, json } from "../_shared/http.ts";
import { ehAdmin, usuarioAtivo } from "../_shared/auth.ts";
import { canalDaLinha, provedorDaLinha } from "../_shared/whatsapp-envio.ts";
import {
  apontarAvisosConexaoZapi,
  celularConectadoZapi,
  desconectarZapi,
  qrCodeZapi,
  statusZapi,
  urlAvisoConexaoZapi,
} from "../_shared/zapi.ts";
import type { CanalZapi } from "../_shared/zapi.ts";

const LOG = "[ic-whatsapp-conexao]";
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_CONFERENCIA_S = 60;
const HISTORICO_MAX = 50;

function canalZapi(linha: any): CanalZapi | null {
  const r = canalDaLinha(linha, (n) => Deno.env.get(n));
  return r.ok && r.canal.provedor === "zapi" ? r.canal : null;
}

function estadoDoBanco(linha: any): boolean | null {
  if (linha.zapi_estado === "conectado") return true;
  if (linha.zapi_estado === "desconectado") return false;
  return null;
}

type Registro = { conectado: boolean; desde: string | null; numero: string | null };

// Ao CONECTAR com o canal em maos, pergunta a Z-API qual celular leu o QR
// Code e manda junto: se for outro numero (chip de teste trocado pelo
// oficial), a SQL 49 atualiza o cadastro. Sem SQL 49, grava sem o numero.
async function registrar(
  sb: SupabaseClient, linhaId: string, conectado: boolean, origem: "consulta" | "tela", usuarioId: string | null,
  canal: CanalZapi | null = null,
): Promise<Registro | null> {
  const args: Record<string, unknown> = {
    p_linha_id: linhaId,
    p_conectado: conectado,
    p_origem: origem,
    p_usuario_id: usuarioId,
  };
  if (conectado && canal) {
    const numero = await celularConectadoZapi(canal, LOG);
    if (numero) args.p_numero = numero;
  }
  let { data, error } = await sb.rpc("ic_whatsapp_registrar_estado", args);
  if (error && "p_numero" in args) {
    console.warn(LOG, "registrar com numero falhou (SQL 49 aplicado?):", error.message);
    delete args.p_numero;
    ({ data, error } = await sb.rpc("ic_whatsapp_registrar_estado", args));
  }
  if (error) {
    console.error(LOG, "registrar estado falhou (SQL 48 aplicado?):", error.message);
    return null;
  }
  if ((data as any)?.mudou) console.log(LOG, conectado ? "WhatsApp conectado" : "WhatsApp desconectado", "(", origem, ")", linhaId);
  return { conectado, desde: (data as any)?.desde ?? null, numero: (data as any)?.numero ?? null };
}

async function reservar(sb: SupabaseClient, linhaId: string): Promise<boolean> {
  const { data, error } = await sb.rpc("ic_whatsapp_reservar_conferencia", { p_linha_id: linhaId, p_segundos: CACHE_CONFERENCIA_S });
  if (error) {
    // Sem SQL 48 (ou falha): confere direto, como antes.
    console.warn(LOG, "reserva da conferencia falhou:", error.message);
    return true;
  }
  return data === true;
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
    const admin = ehAdmin(auth.usuario);

    let payload: any = {};
    try {
      payload = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "acao_invalida" }, 400);
    }
    const acao = String((payload && payload.acao) || "");

    const { data: linhas, error } = await sb
      .from("vendedores_whatsapp")
      .select("*")
      .eq("ativo", true);
    if (error) {
      console.error(LOG, "vendedores_whatsapp falhou:", error.message);
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    const zapi = ((linhas as any[]) || []).filter((l) => provedorDaLinha(l) === "zapi" && l.zapi_instancia);

    if (acao === "status") {
      const forcar = admin && payload.forcar === true;
      const out = await Promise.all(zapi.map(async (l) => {
        const base = { id: String(l.id), nome: l.vendedor_nome || null, numero: l.numero_whatsapp || null };
        const estavaConectado = estadoDoBanco(l) === true;
        let conectado = estadoDoBanco(l);
        let celular: boolean | null = null;
        let desde: string | null = l.zapi_estado_desde || null;
        const canal = canalZapi(l);
        if (canal && (forcar || conectado === null || await reservar(sb, String(l.id)))) {
          const s = await statusZapi(canal, LOG);
          if (s.ok) {
            // Conferencia do Admin com a tela/QR aberta que acha o numero de
            // volta: credita a ele a reconexao (a queda nunca e "dele").
            const dele = forcar && s.conectado;
            // Confere qual celular esta conectado so quando voltou agora ou o
            // Admin pediu (troca de numero), nao a cada minuto.
            const conferirNumero = s.conectado && (forcar || !estavaConectado);
            const reg = await registrar(sb, String(l.id), s.conectado, dele ? "tela" : "consulta", dele ? auth.usuario.id : null,
              conferirNumero ? canal : null);
            conectado = s.conectado;
            celular = s.celularOnline;
            if (reg) {
              desde = reg.desde;
              if (reg.numero) base.numero = reg.numero;
            }
          } else {
            console.warn(LOG, "status indisponivel:", s.status, s.detalhe);
          }
        }
        return { ...base, conectado, celular_online: celular, desde, conferido_em: l.zapi_conferido_em || null };
      }));
      return json({ ok: true, linhas: out, desconectado: out.some((l) => l.conectado === false) });
    }

    if (!admin) return json({ ok: false, erro: "somente_admin" }, 403);

    if (acao === "historico") {
      const ids = zapi.map((l) => String(l.id));
      if (!ids.length) return json({ ok: true, eventos: [] });
      const { data: evs, error: errE } = await sb
        .from("ic_whatsapp_conexao_eventos")
        .select("id, linha_id, estado, origem, usuario_id, criado_em")
        .in("linha_id", ids)
        .order("criado_em", { ascending: false })
        .limit(HISTORICO_MAX);
      if (errE) {
        console.error(LOG, "historico falhou (SQL 48 aplicado?):", errE.message);
        return json({ ok: false, erro: "erro_interno" }, 500);
      }
      const lista = (evs as any[]) || [];
      const userIds = [...new Set(lista.map((e) => e.usuario_id).filter(Boolean))];
      const nomes: Record<string, string> = {};
      if (userIds.length) {
        const { data: us } = await sb.from("users").select("id, name").in("id", userIds);
        for (const u of (us as any[]) || []) nomes[String(u.id)] = u.name || "";
      }
      const numero: Record<string, string> = {};
      for (const l of zapi) numero[String(l.id)] = l.numero_whatsapp || "";
      // Tempo fora: da queda ate a proxima reconexao do mesmo numero (lista vem do mais novo).
      const proximaConexao: Record<string, number> = {};
      const eventos = lista.map((e) => {
        const t = Date.parse(e.criado_em);
        let fora: number | null = null;
        if (e.estado === "desconectado") {
          const volta = proximaConexao[e.linha_id];
          fora = volta ? volta - t : Date.now() - t;
        } else {
          proximaConexao[e.linha_id] = t;
        }
        return {
          id: e.id,
          linha_id: e.linha_id,
          numero: numero[e.linha_id] || null,
          estado: e.estado,
          origem: e.origem,
          quando: e.criado_em,
          usuario: e.usuario_id ? (nomes[String(e.usuario_id)] || null) : null,
          fora_ms: fora,
          em_aberto: e.estado === "desconectado" && !proximaConexao[e.linha_id],
        };
      });
      return json({ ok: true, eventos });
    }

    if (acao !== "qrcode" && acao !== "testar" && acao !== "desconectar") {
      return json({ ok: false, erro: "acao_invalida" }, 400);
    }
    const linhaId = String((payload && payload.linha_id) || "");
    if (!RE_UUID.test(linhaId)) return json({ ok: false, erro: "linha_invalida" }, 400);
    const linha = zapi.find((l) => String(l.id) === linhaId);
    if (!linha) return json({ ok: false, erro: "linha_nao_encontrada" }, 404);
    const canal = canalZapi(linha);
    if (!canal) return json({ ok: false, erro: "zapi_nao_configurada" }, 503);

    if (acao === "qrcode") {
      const s = await statusZapi(canal, LOG);
      if (s.ok && s.conectado) {
        await registrar(sb, linhaId, true, "tela", auth.usuario.id, canal);
        return json({ ok: true, ja_conectado: true });
      }
      const qr = await qrCodeZapi(canal, LOG);
      if (qr.ok) {
        console.log(LOG, "QR Code pedido pelo usuario", auth.usuario.id);
        return json({ ok: true, imagem: qr.imagem });
      }
      console.warn(LOG, "QR indisponivel:", qr.motivo, qr.detalhe);
      return json({ ok: false, erro: qr.motivo }, qr.motivo === "chave_de_acesso" ? 409 : 502);
    }

    if (acao === "testar") {
      const s = await statusZapi(canal, LOG);
      if (!s.ok) return json({ ok: false, erro: "zapi_indisponivel", detalhe: s.status === 0 ? "sem_resposta" : "recusou" }, 502);
      const reg = await registrar(sb, linhaId, s.conectado, "consulta", null, canal);
      let avisos: "ok" | "falhou" | "sem_segredo" = "sem_segredo";
      const segredo = Deno.env.get("ZAPI_WEBHOOK_TOKEN") || "";
      if (segredo) {
        const r = await apontarAvisosConexaoZapi(canal, urlAvisoConexaoZapi(URL_SB, segredo), LOG);
        avisos = r.ok ? "ok" : "falhou";
        if (!r.ok) console.warn(LOG, "apontar avisos de conexao falhou:", r.status, r.detalhe);
        else console.log(LOG, "avisos de conexao apontados para o ic-meta-webhook por", auth.usuario.id);
      }
      return json({ ok: true, conectado: s.conectado, celular_online: s.celularOnline, avisos, numero: reg?.numero ?? null });
    }

    // desconectar: grava ANTES (com quem fez), porque o aviso da Z-API pode
    // chegar antes da resposta. Se a Z-API recusar, a conferencia devolve o
    // estado real.
    await registrar(sb, linhaId, false, "tela", auth.usuario.id);
    const d = await desconectarZapi(canal, LOG);
    if (d.ok) {
      console.warn(LOG, "WhatsApp desconectado pela tela por", auth.usuario.id);
      return json({ ok: true });
    }
    console.warn(LOG, "desconectar recusado:", d.status, d.detalhe);
    const s = await statusZapi(canal, LOG);
    if (s.ok && s.conectado) await registrar(sb, linhaId, true, "consulta", null, canal);
    return json({ ok: false, erro: "zapi_recusou", conectado: s.ok ? s.conectado : null }, 502);
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});
