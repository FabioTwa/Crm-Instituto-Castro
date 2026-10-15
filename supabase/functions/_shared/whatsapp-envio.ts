// Escolhe o provedor de envio do WhatsApp pelo numero do vendedor
// (vendedores_whatsapp.provedor) e envia por ele. Usado por ic-whatsapp-send
// (equipe) e ic-ia-pre-atendimento (IA).
//
//   provedor 'meta'    -> Cloud API direta (_shared/whatsapp-cloud.ts),
//                         precisa de meta_phone_id + META_ACCESS_TOKEN
//   provedor 'gupshup' -> Gupshup (_shared/gupshup.ts),
//                         precisa de gupshup_app + numero_whatsapp + GUPSHUP_API_KEY
//   provedor 'zapi'    -> Z-API (_shared/zapi.ts), so para a fase de treino,
//                         precisa de zapi_instancia + ZAPI_INSTANCE_TOKEN + ZAPI_CLIENT_TOKEN
//
// Linha sem a coluna provedor (SQL 28 ainda nao aplicado) vale como 'meta':
// o comportamento antigo continua igual.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { enviarTemplate, enviarTexto, type ResultadoEnvio } from "./whatsapp-cloud.ts";
import { enviarTemplateGupshup, enviarTextoGupshup } from "./gupshup.ts";
import { enviarTextoZapi } from "./zapi.ts";
import { canonicoTelefone } from "./telefone.ts";

export type Provedor = "meta" | "gupshup" | "zapi";

export type CanalEnvio =
  | { provedor: "meta"; phoneId: string; token: string }
  | { provedor: "gupshup"; app: string; origem: string; apiKey: string }
  | { provedor: "zapi"; instancia: string; token: string; clientToken: string };

// Motivo de nao ter canal, para log e resposta ao front.
export type SemCanal = { provedor: Provedor | null; motivo: "sem_numero" | "numero_incompleto" | "sem_credencial" };

export function provedorDaLinha(linha: any): Provedor {
  const p = String((linha && linha.provedor) || "meta").toLowerCase();
  return p === "gupshup" || p === "zapi" ? p : "meta";
}

// Monta o canal a partir da linha de vendedores_whatsapp e dos segredos.
// Funcao pura (env injetado) para poder testar.
export function canalDaLinha(
  linha: any,
  env: (nome: string) => string | undefined,
): { ok: true; canal: CanalEnvio } | ({ ok: false } & SemCanal) {
  if (!linha) return { ok: false, provedor: null, motivo: "sem_numero" };
  const provedor = provedorDaLinha(linha);
  if (provedor === "gupshup") {
    const app = String(linha.gupshup_app || "").trim();
    const origem = canonicoTelefone(String(linha.numero_whatsapp || ""));
    if (!app || !origem) return { ok: false, provedor, motivo: "numero_incompleto" };
    const apiKey = env("GUPSHUP_API_KEY") || "";
    if (!apiKey) return { ok: false, provedor, motivo: "sem_credencial" };
    return { ok: true, canal: { provedor, app, origem, apiKey } };
  }
  if (provedor === "zapi") {
    const instancia = String(linha.zapi_instancia || "").trim();
    if (!instancia) return { ok: false, provedor, motivo: "numero_incompleto" };
    // Tokens nos segredos das funcoes, nunca no banco (a coluna antiga
    // zapi_token nao e usada).
    const token = env("ZAPI_INSTANCE_TOKEN") || "";
    const clientToken = env("ZAPI_CLIENT_TOKEN") || "";
    if (!token || !clientToken) return { ok: false, provedor, motivo: "sem_credencial" };
    return { ok: true, canal: { provedor, instancia, token, clientToken } };
  }
  const phoneId = String(linha.meta_phone_id || "").trim();
  if (!phoneId) return { ok: false, provedor, motivo: "numero_incompleto" };
  const token = env("META_ACCESS_TOKEN") || "";
  if (!token) return { ok: false, provedor, motivo: "sem_credencial" };
  return { ok: true, canal: { provedor, phoneId, token } };
}

// Le o numero ativo do vendedor. select("*") de proposito: funciona antes e
// depois do SQL 28 (colunas provedor/gupshup_app).
export async function canalDoVendedor(
  sb: SupabaseClient,
  vendedorId: string,
): Promise<{ ok: true; canal: CanalEnvio } | ({ ok: false; erroBanco?: string } & SemCanal)> {
  const { data, error } = await sb
    .from("vendedores_whatsapp")
    .select("*")
    .eq("vendedor_id", vendedorId)
    .eq("ativo", true)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, provedor: null, motivo: "sem_numero", erroBanco: error.message };
  const linhas = (data as any[]) || [];
  // Prefere a linha que tem o identificador do proprio provedor preenchido.
  const linha = linhas.find((l) => {
    const p = provedorDaLinha(l);
    if (p === "gupshup") return !!l.gupshup_app;
    if (p === "zapi") return !!l.zapi_instancia;
    return !!l.meta_phone_id;
  }) || null;
  return canalDaLinha(linha, (n) => Deno.env.get(n));
}

export async function enviarTextoCanal(
  canal: CanalEnvio,
  para: string,
  texto: string,
  prefixoLog: string,
): Promise<ResultadoEnvio> {
  if (canal.provedor === "gupshup") {
    return await enviarTextoGupshup({ canal, para, texto, prefixoLog });
  }
  if (canal.provedor === "zapi") {
    return await enviarTextoZapi({ canal, para, texto, prefixoLog });
  }
  return await enviarTexto({ phoneId: canal.phoneId, token: canal.token, para, texto, prefixoLog });
}

// Modelo aprovado. Meta: {name, language, components}. Gupshup: {id, params}
// (o Gupshup identifica o modelo pelo ID dele, visto no painel).
export type ModeloEnvio = { name?: string; language?: string; components?: unknown[]; id?: string; params?: unknown[] };

// Z-API nao tem modelo aprovado: nunca e valido ali.
export function modeloValido(canal: CanalEnvio, t: ModeloEnvio): boolean {
  if (canal.provedor === "zapi") return false;
  if (canal.provedor === "gupshup") return typeof t.id === "string" && t.id.trim().length > 0;
  return typeof t.name === "string" && t.name.trim().length > 0;
}

export async function enviarModeloCanal(
  canal: CanalEnvio,
  para: string,
  t: ModeloEnvio,
  prefixoLog: string,
): Promise<ResultadoEnvio> {
  if (canal.provedor === "gupshup") {
    return await enviarTemplateGupshup({
      canal,
      para,
      template: { id: String(t.id), params: Array.isArray(t.params) ? t.params : [] },
      prefixoLog,
    });
  }
  if (canal.provedor === "zapi") {
    return { ok: false, status: 400, codigoMeta: null, mensagemMeta: "Z-API nao envia modelo", foraDaJanela24h: false, resposta: null };
  }
  return await enviarTemplate({
    phoneId: canal.phoneId,
    token: canal.token,
    para,
    template: { name: String(t.name), language: String(t.language || "pt_BR"), components: t.components },
    prefixoLog,
  });
}
