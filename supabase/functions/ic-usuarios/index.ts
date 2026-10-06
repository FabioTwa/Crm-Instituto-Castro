// ic-usuarios: cria usuario do CRM no Supabase Auth + public.users. So Admin.
//
// Quem chama: o FRONT (tela Usuarios -> Novo Usuario), via supabaseClient.functions.invoke.
// Publicar: supabase functions deploy ic-usuarios        (verify_jwt LIGADO)
//
// Por que existe: criar a conta no Auth exige a service_role, que nunca vai ao
// navegador. A senha vai SO para o Auth; public.users.pw fica 'supabase_auth'
// (o banco recusa outro valor, ver 25_ic_usuarios_auth.sql).
//
// CONTRATO
//   POST { acao: 'criar', name, email, password, perfil, perfil_id?,
//          vendedor_responsavel_id?, vendedor_responsavel_nome?,
//          vendedores_responsaveis_ids?, telas_permitidas? }
//   200 { ok: true, id }
//   400 { ok: false, erro: 'payload_invalido' | 'senha_fraca' | 'perfil_invalido' }
//   401/403 { ok: false, erro: 'sem_token' | 'token_invalido' | 'usuario_inativo' | 'usuario_nao_cadastrado' | 'somente_admin' }
//   409 { ok: false, erro: 'email_ja_cadastrado' }
//   500 { ok: false, erro: 'erro_interno' }
//
// ATOMICIDADE: se o insert em public.users falhar, a conta recem-criada no Auth
// e apagada, para nao sobrar login sem cadastro.
//
// VARIAVEIS DE AMBIENTE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (o Supabase injeta)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, erroGenerico, json } from "../_shared/http.ts";
import { ehAdmin, usuarioAtivo } from "../_shared/auth.ts";
import { validarNovoUsuario } from "../_shared/usuarios.ts";

const LOG = "[ic-usuarios]";

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
    const sb = createClient(URL_SB, SR, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1) Quem chama: usuario ativo e Admin.
    const auth = await usuarioAtivo(req, sb);
    if (!auth.ok) return json({ ok: false, erro: auth.erro }, auth.status);
    if (!ehAdmin(auth.usuario)) return json({ ok: false, erro: "somente_admin" }, 403);

    let payload: unknown = null;
    try {
      payload = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "payload_invalido" }, 400);
    }
    if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).acao !== "criar") {
      return json({ ok: false, erro: "payload_invalido" }, 400);
    }

    // 2) Validacao (mesmas regras de senha do front).
    const v = validarNovoUsuario(payload as Record<string, unknown>);
    if (!v.ok) return json({ ok: false, erro: v.erro }, 400);
    const d = v.dados;

    // 3) Perfil existe. Sem perfil_id, acha pelo nome: linha sem perfil_id
    //    some dos filtros por perfil e confunde a tela de Usuarios.
    if (!d.perfil_id) {
      const { data: pn, error: errN } = await sb.from("perfis_acesso").select("id").eq("nome", d.perfil).maybeSingle();
      if (errN) {
        console.error(LOG, "consulta perfis_acesso por nome falhou:", errN.message);
        return json({ ok: false, erro: "erro_interno" }, 500);
      }
      if (pn) d.perfil_id = (pn as { id: string }).id;
    }
    if (d.perfil_id) {
      const { data: p, error: errP } = await sb.from("perfis_acesso").select("id").eq("id", d.perfil_id).maybeSingle();
      if (errP) {
        console.error(LOG, "consulta perfis_acesso falhou:", errP.message);
        return json({ ok: false, erro: "erro_interno" }, 500);
      }
      if (!p) return json({ ok: false, erro: "perfil_invalido" }, 400);
    }

    // 4) E-mail livre em public.users.
    const { data: existe, error: errE } = await sb.from("users").select("id").ilike("email", d.email).limit(1).maybeSingle();
    if (errE) {
      console.error(LOG, "consulta users falhou:", errE.message);
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    if (existe) return json({ ok: false, erro: "email_ja_cadastrado" }, 409);

    // 5) Conta no Auth (e-mail ja confirmado: quem cria e o Admin).
    const { data: criado, error: errAuth } = await sb.auth.admin.createUser({
      email: d.email,
      password: d.password,
      email_confirm: true,
      user_metadata: { name: d.name },
    });
    if (errAuth || !criado || !criado.user) {
      const msg = String(errAuth?.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        return json({ ok: false, erro: "email_ja_cadastrado" }, 409);
      }
      if (msg.includes("password")) return json({ ok: false, erro: "senha_fraca" }, 400);
      console.error(LOG, "auth.admin.createUser falhou:", errAuth?.message);
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    const authId = criado.user.id;

    // 6) Linha em public.users. Falhou: desfaz a conta do Auth.
    const { data: linha, error: errIns } = await sb
      .from("users")
      .insert({
        name: d.name,
        email: d.email,
        pw: "supabase_auth",
        role: d.perfil.toUpperCase() === "ADMIN" ? "admin" : "operador",
        perfil: d.perfil,
        perfil_id: d.perfil_id,
        status: "ativo",
        vendedor_responsavel_id: d.vendedor_responsavel_id,
        vendedor_responsavel_nome: d.vendedor_responsavel_nome,
        vendedores_responsaveis_ids: d.vendedores_responsaveis_ids,
        telas_permitidas: d.telas_permitidas,
      })
      .select("id")
      .single();
    if (errIns || !linha) {
      console.error(LOG, "insert users falhou, desfazendo conta do Auth:", errIns?.message);
      const { error: errDel } = await sb.auth.admin.deleteUser(authId);
      if (errDel) console.error(LOG, "ATENCAO: conta do Auth ficou sem cadastro, apagar manualmente:", authId, errDel.message);
      return json({ ok: false, erro: "erro_interno" }, 500);
    }

    console.log(LOG, "usuario criado:", (linha as { id: string }).id, "por", auth.usuario.id);
    return json({ ok: true, id: (linha as { id: string }).id });
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});
