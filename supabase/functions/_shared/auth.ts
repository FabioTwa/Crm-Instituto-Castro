// Autenticacao das edge functions do IC CRM.
//
// Duas portas:
// 1) FRONT (usuario logado): o gateway do Supabase ja validou o JWT quando a
//    funcao e publicada com verify_jwt (padrao). Aqui, alem disso, resolvemos
//    o usuario em public.users pelo e-mail do JWT e negamos se nao existir ou
//    se status != 'ativo'. Quando a funcao precisa ser publicada com
//    --no-verify-jwt (caso do callback OAuth do Google, que chega sem JWT),
//    este mesmo helper valida o token de verdade via auth.getUser(jwt).
// 2) INTERNA (webhook -> IA -> agendamento, pg_cron): segredo compartilhado
//    IC_INTERNAL_SECRET no header x-ic-internal, comparado em tempo constante.
//
// Variaveis de ambiente lidas aqui: IC_INTERNAL_SECRET.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { iguaisTempoConstante } from "./crypto.ts";

export type UsuarioAtivo = {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  perfil: string | null;
  vendedor_responsavel_id: string | null;
};

export type ResultadoAuth =
  | { ok: true; usuario: UsuarioAtivo }
  | { ok: false; status: number; erro: string };

export function tokenDoHeader(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

// Resolve o usuario logado. `sbServico` e um client com SERVICE_ROLE (bypass
// de RLS), usado tanto para validar o JWT (auth.getUser) quanto para ler
// public.users.
export async function usuarioAtivo(req: Request, sbServico: SupabaseClient): Promise<ResultadoAuth> {
  const jwt = tokenDoHeader(req);
  if (!jwt) return { ok: false, status: 401, erro: "sem_token" };

  const { data, error } = await sbServico.auth.getUser(jwt);
  if (error || !data || !data.user) return { ok: false, status: 401, erro: "token_invalido" };
  const email = String(data.user.email || "").trim().toLowerCase();
  if (!email) return { ok: false, status: 401, erro: "token_sem_email" };

  const { data: u, error: errU } = await sbServico
    .from("users")
    .select("id, email, name, role, perfil, status, vendedor_responsavel_id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle();
  if (errU) {
    console.error("[auth] consulta public.users falhou:", errU.message);
    return { ok: false, status: 500, erro: "erro_interno" };
  }
  if (!u) return { ok: false, status: 403, erro: "usuario_nao_cadastrado" };
  if (String((u as any).status || "") !== "ativo") return { ok: false, status: 403, erro: "usuario_inativo" };

  return {
    ok: true,
    usuario: {
      id: String((u as any).id),
      email: String((u as any).email || email),
      name: (u as any).name ?? null,
      role: (u as any).role ?? null,
      perfil: (u as any).perfil ?? null,
      vendedor_responsavel_id: (u as any).vendedor_responsavel_id ?? null,
    },
  };
}

// Admin = role 'admin' ou perfil que comece com "admin" (public.users.perfil
// default 'Vendedor'; o perfil 'Admin' e o de quem ve tudo).
export function ehAdmin(u: UsuarioAtivo): boolean {
  const role = String(u.role || "").toLowerCase();
  const perfil = String(u.perfil || "").toLowerCase();
  return role === "admin" || perfil.startsWith("admin");
}

// Chamada interna entre funcoes / pg_cron: header x-ic-internal == IC_INTERNAL_SECRET.
export function chamadaInternaValida(req: Request): boolean {
  const esperado = Deno.env.get("IC_INTERNAL_SECRET") || "";
  if (!esperado) return false;
  return iguaisTempoConstante(req.headers.get("x-ic-internal") || "", esperado);
}

// Cabecalhos para UMA funcao chamar OUTRA internamente. O Authorization com a
// service role e para passar pelo gateway quando a funcao alvo tem verify_jwt;
// a autorizacao de verdade e o x-ic-internal.
export function headersInternos(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-ic-internal": Deno.env.get("IC_INTERNAL_SECRET") || "",
    Authorization: "Bearer " + (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""),
    apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  };
}
