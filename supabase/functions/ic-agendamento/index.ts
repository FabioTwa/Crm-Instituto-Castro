// ic-agendamento: agendamentos do IC CRM + sincronizacao com o Google Calendar
// (API REST direta, sem SDK) + OAuth do Google por usuario.
//
// DUAS PORTAS
//  (a) FRONT (usuario logado; JWT validado em codigo via auth.getUser + public.users ativo):
//      {acao:'criar', cliente_crm_id, inicio, fim, responsavel_id?, titulo, tipo?, observacoes?}
//      {acao:'status', id, status}                      status: 'confirmado'|'cancelado'|'realizado'|'faltou'|...
//      {acao:'sincronizar_pendentes'}                   so admin
//      {acao:'google_oauth_url'}                        URL de consentimento OAuth para o usuario logado
//      {acao:'google_oauth_callback', code, state}      troca code por refresh_token e guarda cifrado
//      GET ?acao=google_oauth_callback&code=&state=     (o Google redireciona para ca; redireciona ao IC_APP_URL)
//  (b) INTERNA (header x-ic-internal = IC_INTERNAL_SECRET):
//      {acao:'propor', cliente_crm_id, dia_preferido, periodo, servico, observacao}
//        -> cria agendamentos status 'pendente', origem 'ia'. NAO confirma. {ok, confirmado:false, agendamento_id}
//
// PUBLICAR: supabase functions deploy ic-agendamento --no-verify-jwt
//   Por que --no-verify-jwt aqui? O callback OAuth chega do Google sem JWT do
//   Supabase; com verify_jwt o gateway devolveria 401 antes do codigo rodar.
//   Em troca, TODA acao do front passa por usuarioAtivo() (auth.getUser valida
//   o JWT de verdade contra o Auth) e o callback e protegido pelo state assinado
//   (HS256 com IC_INTERNAL_SECRET, 10 min).
//
// GOOGLE (minimizacao): no evento vao APENAS nome do lead, telefone, funil/etapa,
// horario e o link do card. Nada clinico, nada de observacoes.
//   summary:     "[IC CRM] {titulo} — {nome do lead}"
//   description: "Telefone: {telefone}\nFunil: ... / Etapa: ...\nCard: {IC_APP_URL}/#card={id}"
//   extendedProperties.private.ic_agendamento_id = id
// google_sync_status: 'sincronizado' | 'erro' (+google_sync_erro) | 'desligado'
// (flag agendamento_google off ou responsavel sem credencial) | 'pendente'.
//
// VARIAVEIS DE AMBIENTE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (o Supabase injeta)
//   IC_INTERNAL_SECRET     chamadas internas e assinatura do state OAuth
//   IC_CRYPTO_KEY          32 bytes em base64; AES-GCM do refresh_token
//   IC_APP_URL             URL do front (link do card; redirecionamento pos-OAuth)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
//     (redirect = {SUPABASE_URL}/functions/v1/ic-agendamento?acao=google_oauth_callback)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, erroGenerico, json } from "../_shared/http.ts";
import { chamadaInternaValida, ehAdmin, usuarioAtivo, type UsuarioAtivo } from "../_shared/auth.ts";
import { icFlag } from "../_shared/flags.ts";
import { assinarToken, cifrar, decifrar, verificarToken } from "../_shared/crypto.ts";
import { proximoSlot, TZ_PADRAO } from "../_shared/horario.ts";
import { canonicoTelefone } from "../_shared/telefone.ts";

const LOG = "[ic-agendamento]";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const STATUS_CANCELADO = new Set(["cancelado", "cancelada"]);
const STATUS_SINCRONIZA = new Set(["confirmado", "confirmada", "agendado", "agendada", "remarcado", "remarcada"]);

type Agendamento = {
  id: string;
  cliente_crm_id: string | null;
  funil_id: string | null;
  responsavel_id: string | null;
  responsavel_nome: string | null;
  titulo: string | null;
  inicio: string;
  fim: string;
  status: string | null;
  tipo: string | null;
  telefone_lead: string | null;
  observacoes: string | null;
  origem: string | null;
  google_event_id: string | null;
  google_calendar_id: string | null;
  google_sync_status: string | null;
};

const SEL_AG =
  "id, cliente_crm_id, funil_id, responsavel_id, responsavel_nome, titulo, inicio, fim, status, tipo, telefone_lead, observacoes, origem, google_event_id, google_calendar_id, google_sync_status";

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------
async function accessTokenGoogle(refreshToken: string): Promise<string | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) {
    console.error(LOG, "GOOGLE_CLIENT_ID/SECRET ausentes");
    return null;
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    console.error(LOG, "refresh do access token falhou:", resp.status, String(data.error || "").slice(0, 100));
    return null;
  }
  return String(data.access_token);
}

async function credencialDoResponsavel(sb: SupabaseClient, responsavelId: string | null) {
  if (!responsavelId) return null;
  const { data, error } = await sb
    .from("ic_google_credenciais")
    .select("user_id, google_email, refresh_token_cifrado, calendar_id, ativo")
    .eq("user_id", responsavelId)
    .eq("ativo", true)
    .maybeSingle();
  if (error) {
    console.error(LOG, "ic_google_credenciais falhou:", error.message);
    return null;
  }
  return data as any | null;
}

async function marcarSync(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await sb.from("agendamentos").update(patch).eq("id", id);
  if (error) console.error(LOG, "update agendamentos (sync) falhou:", error.message);
}

// Cria ou atualiza o evento do agendamento no Google do responsavel.
async function sincronizarGoogle(sb: SupabaseClient, ag: Agendamento): Promise<{ status: string; erro?: string }> {
  try {
    if (!(await icFlag(sb, "agendamento_google"))) {
      await marcarSync(sb, ag.id, { google_sync_status: "desligado", google_sync_erro: null });
      return { status: "desligado" };
    }
    const cred = await credencialDoResponsavel(sb, ag.responsavel_id);
    if (!cred || !cred.refresh_token_cifrado) {
      await marcarSync(sb, ag.id, { google_sync_status: "desligado", google_sync_erro: "responsavel sem Google conectado" });
      return { status: "desligado" };
    }
    const chave = Deno.env.get("IC_CRYPTO_KEY") || "";
    const refresh = await decifrar(String(cred.refresh_token_cifrado), chave);
    const token = await accessTokenGoogle(refresh);
    if (!token) {
      await marcarSync(sb, ag.id, { google_sync_status: "erro", google_sync_erro: "nao foi possivel obter access token" });
      return { status: "erro", erro: "token" };
    }

    // Dados minimos do lead: nome, telefone, funil/etapa.
    let nomeLead = "", telefone = ag.telefone_lead || "", funilNome = "", etapa = "";
    if (ag.cliente_crm_id) {
      const { data: card } = await sb
        .from("clientes_crm")
        .select("nome, telefone, numero_whatsapp, etapa, funil_id")
        .eq("id", ag.cliente_crm_id)
        .maybeSingle();
      if (card) {
        nomeLead = String((card as any).nome || "");
        if (!telefone) telefone = canonicoTelefone(String((card as any).numero_whatsapp || (card as any).telefone || ""));
        etapa = String((card as any).etapa || "");
        const funilId = (card as any).funil_id || ag.funil_id;
        if (funilId) {
          const { data: f } = await sb.from("crm_funis").select("nome").eq("id", funilId).maybeSingle();
          funilNome = f ? String((f as any).nome || "") : "";
          const { data: e } = await sb.from("crm_funil_etapas").select("label, nome").eq("funil_id", funilId).eq("nome", etapa).maybeSingle();
          if (e) etapa = String((e as any).label || (e as any).nome || etapa);
        }
      }
    }
    const appUrl = (Deno.env.get("IC_APP_URL") || "").replace(/\/+$/, "");
    const evento = {
      summary: `[IC CRM] ${ag.titulo || "Avaliação"} — ${nomeLead || "lead"}`,
      description:
        `Telefone: ${telefone || "não informado"}\n` +
        `Funil: ${funilNome || "-"} / Etapa: ${etapa || "-"}\n` +
        (ag.cliente_crm_id ? `Card: ${appUrl}/#card=${ag.cliente_crm_id}\n` : "") +
        `Status no CRM: ${ag.status || "-"}`,
      start: { dateTime: new Date(ag.inicio).toISOString(), timeZone: TZ_PADRAO },
      end: { dateTime: new Date(ag.fim).toISOString(), timeZone: TZ_PADRAO },
      extendedProperties: { private: { ic_agendamento_id: ag.id } },
    };

    const calendarId = String(ag.google_calendar_id || cred.calendar_id || "primary");
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    let resp: Response;
    if (ag.google_event_id) {
      resp = await fetch(`${base}/${encodeURIComponent(ag.google_event_id)}`, { method: "PATCH", headers, body: JSON.stringify(evento) });
      if (resp.status === 404 || resp.status === 410) {
        resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(evento) });
      }
    } else {
      resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(evento) });
    }
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.id) {
      const msg = String((data.error && data.error.message) || `HTTP ${resp.status}`).slice(0, 300);
      console.error(LOG, "Google Calendar recusou:", resp.status, msg);
      await marcarSync(sb, ag.id, { google_sync_status: "erro", google_sync_erro: msg });
      return { status: "erro", erro: msg };
    }
    await marcarSync(sb, ag.id, {
      google_event_id: String(data.id),
      google_calendar_id: calendarId,
      google_sync_status: "sincronizado",
      google_sync_erro: null,
    });
    return { status: "sincronizado" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(LOG, "sincronizarGoogle excecao:", msg);
    await marcarSync(sb, ag.id, { google_sync_status: "erro", google_sync_erro: msg.slice(0, 300) });
    return { status: "erro", erro: msg };
  }
}

// Cancelamento: apaga o evento (404/410 = ja nao existe, tudo bem).
async function cancelarGoogle(sb: SupabaseClient, ag: Agendamento): Promise<void> {
  if (!ag.google_event_id) return;
  try {
    const cred = await credencialDoResponsavel(sb, ag.responsavel_id);
    if (!cred) return;
    const refresh = await decifrar(String(cred.refresh_token_cifrado), Deno.env.get("IC_CRYPTO_KEY") || "");
    const token = await accessTokenGoogle(refresh);
    if (!token) return;
    const calendarId = String(ag.google_calendar_id || cred.calendar_id || "primary");
    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(ag.google_event_id)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (resp.ok || resp.status === 404 || resp.status === 410) {
      await marcarSync(sb, ag.id, { google_event_id: null, google_sync_status: "desligado", google_sync_erro: null });
    } else {
      await marcarSync(sb, ag.id, { google_sync_status: "erro", google_sync_erro: `delete HTTP ${resp.status}` });
    }
  } catch (e) {
    console.error(LOG, "cancelarGoogle excecao:", e instanceof Error ? e.message : e);
  }
}

async function carregarAgendamento(sb: SupabaseClient, id: string): Promise<Agendamento | null> {
  const { data, error } = await sb.from("agendamentos").select(SEL_AG).eq("id", id).maybeSingle();
  if (error) {
    console.error(LOG, "agendamentos select falhou:", error.message);
    return null;
  }
  return (data as any) || null;
}

// ---------------------------------------------------------------------------
// Acoes do FRONT
// ---------------------------------------------------------------------------
async function acaoCriar(sb: SupabaseClient, u: UsuarioAtivo, body: any): Promise<Response> {
  const clienteId = String(body.cliente_crm_id || "").trim();
  const inicio = new Date(String(body.inicio || ""));
  const fim = new Date(String(body.fim || ""));
  const titulo = String(body.titulo || "").trim();
  if (!clienteId || !titulo || isNaN(inicio.getTime()) || isNaN(fim.getTime()) || fim <= inicio) {
    return json({ ok: false, erro: "payload_invalido" }, 400);
  }
  const responsavel = String(body.responsavel_id || u.vendedor_responsavel_id || u.id);
  const { data, error } = await sb.rpc("ic_agendamento_criar", {
    p_cliente: clienteId,
    p_inicio: inicio.toISOString(),
    p_fim: fim.toISOString(),
    p_responsavel: responsavel,
    p_titulo: titulo,
    p_tipo: body.tipo != null ? String(body.tipo) : null,
    p_obs: body.observacoes != null ? String(body.observacoes) : null,
  });
  if (error) {
    console.error(LOG, "ic_agendamento_criar falhou:", error.message);
    return json({ ok: false, erro: "criar_falhou" }, 400);
  }
  const id = typeof data === "string" ? data : data && (data as any).id ? String((data as any).id) : null;
  if (!id) return json({ ok: false, erro: "criar_sem_id" }, 500);
  // criado_por: o RPC pode ja preencher; aqui so complementa se estiver vazio.
  await sb.from("agendamentos").update({ criado_por: u.id }).eq("id", id).is("criado_por", null);

  const ag = await carregarAgendamento(sb, id);
  const google = ag ? await sincronizarGoogle(sb, ag) : { status: "erro", erro: "agendamento nao relido" };
  return json({ ok: true, agendamento_id: id, google_sync_status: google.status, google_sync_erro: google.erro ?? null });
}

async function acaoStatus(sb: SupabaseClient, u: UsuarioAtivo, body: any): Promise<Response> {
  const id = String(body.id || "").trim();
  const status = String(body.status || "").trim().toLowerCase();
  if (!id || !status) return json({ ok: false, erro: "payload_invalido" }, 400);

  const { error } = await sb.rpc("ic_agendamento_status", { p_id: id, p_status: status });
  if (error) {
    // RPC pode nao existir ainda (PGRST202 / 42883): cai no update direto.
    const codigo = String((error as any).code || "");
    if (codigo === "PGRST202" || codigo === "42883") {
      console.warn(LOG, "ic_agendamento_status ausente; update direto");
      const { error: e2 } = await sb.from("agendamentos").update({ status }).eq("id", id);
      if (e2) return json({ ok: false, erro: "status_falhou" }, 400);
    } else {
      console.error(LOG, "ic_agendamento_status falhou:", error.message);
      return json({ ok: false, erro: "status_falhou" }, 400);
    }
  }
  const ag = await carregarAgendamento(sb, id);
  if (!ag) return json({ ok: false, erro: "nao_encontrado" }, 404);

  let google = { status: ag.google_sync_status || "pendente", erro: undefined as string | undefined };
  if (STATUS_CANCELADO.has(status)) {
    await cancelarGoogle(sb, ag);
    google = { status: "cancelado", erro: undefined };
  } else if (STATUS_SINCRONIZA.has(status)) {
    google = await sincronizarGoogle(sb, ag) as any;
  }
  console.log(LOG, "status", id, "->", status, "por", u.id);
  return json({ ok: true, agendamento_id: id, status, google_sync_status: google.status, google_sync_erro: google.erro ?? null });
}

async function acaoSincronizarPendentes(sb: SupabaseClient, u: UsuarioAtivo): Promise<Response> {
  if (!ehAdmin(u)) return json({ ok: false, erro: "somente_admin" }, 403);
  const { data, error } = await sb
    .from("agendamentos")
    .select(SEL_AG)
    .in("google_sync_status", ["pendente", "erro"])
    .gte("inicio", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order("inicio", { ascending: true })
    .limit(50);
  if (error) return json({ ok: false, erro: "consulta_falhou" }, 500);
  const resultados: Record<string, string> = {};
  for (const ag of (data as any[]) || []) {
    const st = String(ag.status || "").toLowerCase();
    if (st === "pendente" || STATUS_CANCELADO.has(st)) {
      resultados[ag.id] = "ignorado_" + st;
      continue;
    }
    const r = await sincronizarGoogle(sb, ag as Agendamento);
    resultados[ag.id] = r.status;
  }
  return json({ ok: true, processados: Object.keys(resultados).length, resultados });
}

async function acaoGoogleOauthUrl(u: UsuarioAtivo): Promise<Response> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  const redirect = Deno.env.get("GOOGLE_REDIRECT_URI") || "";
  const segredo = Deno.env.get("IC_INTERNAL_SECRET") || "";
  if (!clientId || !redirect || !segredo) return json({ ok: false, erro: "google_nao_configurado" }, 503);
  const state = await assinarToken({ user_id: u.id, email: u.email }, segredo, 600);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return json({ ok: true, url: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString() });
}

// Troca o code por refresh_token e guarda cifrado. Usado pelo GET (redirect do
// Google) e pelo POST (front repassando code/state).
async function googleOauthCallback(sb: SupabaseClient, code: string, state: string): Promise<{ ok: boolean; erro?: string; email?: string }> {
  const segredo = Deno.env.get("IC_INTERNAL_SECRET") || "";
  const payload = await verificarToken(state, segredo);
  if (!payload || !payload.user_id) return { ok: false, erro: "state_invalido" };
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
  const redirect = Deno.env.get("GOOGLE_REDIRECT_URI") || "";
  const chave = Deno.env.get("IC_CRYPTO_KEY") || "";
  if (!clientId || !clientSecret || !redirect || !chave) return { ok: false, erro: "google_nao_configurado" };

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    console.error(LOG, "troca do code falhou:", resp.status, String(data.error || "").slice(0, 100), data.refresh_token ? "" : "(sem refresh_token: confira prompt=consent e access_type=offline)");
    return { ok: false, erro: "troca_falhou" };
  }

  // E-mail da conta Google (so para exibir qual conta esta ligada).
  let email = "";
  try {
    const ui = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${data.access_token}` } });
    const uj: any = await ui.json().catch(() => ({}));
    email = String(uj.email || "");
  } catch (_e) { /* opcional */ }

  const cifrado = await cifrar(String(data.refresh_token), chave);
  const { error } = await sb.from("ic_google_credenciais").upsert({
    user_id: String(payload.user_id),
    google_email: email || null,
    refresh_token_cifrado: cifrado,
    calendar_id: "primary",
    ativo: true,
  }, { onConflict: "user_id" });
  if (error) {
    console.error(LOG, "ic_google_credenciais upsert falhou:", error.message);
    return { ok: false, erro: "gravar_falhou" };
  }
  console.log(LOG, "Google conectado para o usuario", payload.user_id);
  return { ok: true, email };
}

// ---------------------------------------------------------------------------
// Acao INTERNA: proposta da IA (nunca confirma)
// ---------------------------------------------------------------------------
async function acaoPropor(sb: SupabaseClient, body: any): Promise<Response> {
  const clienteId = String(body.cliente_crm_id || "").trim();
  if (!clienteId) return json({ ok: false, erro: "payload_invalido" }, 400);
  const { data: card, error: errCard } = await sb
    .from("clientes_crm")
    .select("id, vendedor_id, vendedor_nome, funil_id, numero_whatsapp, telefone")
    .eq("id", clienteId)
    .maybeSingle();
  if (errCard || !card) return json({ ok: false, erro: "card_nao_encontrado" }, 404);

  // Ja existe proposta pendente da IA para este card? Nao duplica.
  const { data: jaTem } = await sb
    .from("agendamentos")
    .select("id")
    .eq("cliente_crm_id", clienteId)
    .eq("origem", "ia")
    .eq("status", "pendente")
    .gte("inicio", new Date().toISOString())
    .limit(1);
  if (jaTem && jaTem.length) {
    return json({ ok: true, confirmado: false, agendamento_id: (jaTem[0] as any).id, repetido: true });
  }

  const periodo = body.periodo === "tarde" ? "tarde" : "manha";
  const slot = proximoSlot(String(body.dia_preferido || ""), periodo, new Date(), TZ_PADRAO);
  const servico = String(body.servico || "Avaliação").trim().slice(0, 120);
  const obs = String(body.observacao || "").trim().slice(0, 300);
  const telefone = canonicoTelefone(String((card as any).numero_whatsapp || (card as any).telefone || ""));

  const { data: novo, error } = await sb
    .from("agendamentos")
    .insert({
      cliente_crm_id: clienteId,
      funil_id: (card as any).funil_id || null,
      responsavel_id: (card as any).vendedor_id || null,
      responsavel_nome: (card as any).vendedor_nome || null,
      titulo: "Avaliação — " + servico,
      inicio: slot.inicio.toISOString(),
      fim: slot.fim.toISOString(),
      status: "pendente",
      tipo: "avaliacao",
      telefone_lead: telefone || null,
      observacoes: obs ? "Proposta da IA. " + obs : "Proposta da IA.",
      origem: "ia",
      google_sync_status: "desligado",
      criado_por: "ia",
    })
    .select("id")
    .maybeSingle();
  if (error || !novo) {
    console.error(LOG, "insert agendamentos (propor) falhou:", error ? error.message : "sem retorno");
    return json({ ok: false, erro: "criar_falhou" }, 500);
  }
  return json({ ok: true, confirmado: false, agendamento_id: (novo as any).id, inicio: slot.inicio.toISOString(), fim: slot.fim.toISOString() });
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const URL_SB = Deno.env.get("SUPABASE_URL") || "";
    const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!URL_SB || !SR) {
      console.error(LOG, "SUPABASE_URL/SERVICE_ROLE ausentes");
      return json({ ok: false, erro: "erro_interno" }, 500);
    }
    const sb = createClient(URL_SB, SR, { auth: { persistSession: false } });
    const appUrl = (Deno.env.get("IC_APP_URL") || "").replace(/\/+$/, "");

    // GET: so o retorno do OAuth do Google (redirect do navegador do usuario).
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("acao") !== "google_oauth_callback") return json({ ok: false, erro: "acao_invalida" }, 400);
      if (url.searchParams.get("error")) {
        return Response.redirect(`${appUrl}/#google=erro&motivo=${encodeURIComponent(url.searchParams.get("error") || "")}`, 302);
      }
      const r = await googleOauthCallback(sb, url.searchParams.get("code") || "", url.searchParams.get("state") || "");
      if (!appUrl) return json(r, r.ok ? 200 : 400);
      return Response.redirect(r.ok ? `${appUrl}/#google=ok` : `${appUrl}/#google=erro&motivo=${encodeURIComponent(r.erro || "")}`, 302);
    }
    if (req.method !== "POST") return json({ ok: false, erro: "metodo_nao_suportado" }, 405);

    let body: any = {};
    try {
      body = await req.json();
    } catch (_e) {
      return json({ ok: false, erro: "payload_invalido" }, 400);
    }
    const acao = String(body.acao || "").trim();

    // Porta interna.
    if (acao === "propor") {
      if (!chamadaInternaValida(req)) return json({ ok: false, erro: "nao_autorizado" }, 401);
      return await acaoPropor(sb, body);
    }

    // Porta do front.
    const auth = await usuarioAtivo(req, sb);
    if (!auth.ok) return json({ ok: false, erro: auth.erro }, auth.status);
    const u = auth.usuario;

    switch (acao) {
      case "criar": return await acaoCriar(sb, u, body);
      case "status": return await acaoStatus(sb, u, body);
      case "sincronizar_pendentes": return await acaoSincronizarPendentes(sb, u);
      case "google_oauth_url": return await acaoGoogleOauthUrl(u);
      case "google_oauth_callback": {
        const r = await googleOauthCallback(sb, String(body.code || ""), String(body.state || ""));
        return json(r, r.ok ? 200 : 400);
      }
      default: return json({ ok: false, erro: "acao_invalida" }, 400);
    }
  } catch (e) {
    return erroGenerico(LOG, e);
  }
});
