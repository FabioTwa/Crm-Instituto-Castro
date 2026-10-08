// Escolhe o provedor de envio do WhatsApp pelo numero do vendedor
// (vendedores_whatsapp.provedor) e envia por ele. Usado por ic-whatsapp-send
// (equipe) e ic-ia-pre-atendimento (IA).
//
//   provedor 'meta'    -> Cloud API direta (_shared/whatsapp-cloud.ts),
//                         precisa de meta_phone_id + META_ACCESS_TOKEN
//   provedor 'gupshup' -> Gupshup (_shared/gupshup.ts),
//                         precisa de gupshup_app + numero_whatsapp + GUPSHUP_API_KEY
//
// Linha sem a coluna provedor (SQL 28 ainda nao aplicado) vale como 'meta':
// o comportamento antigo continua igual.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { enviarTemplate, enviarTexto, type ResultadoEnvio } from "./whatsapp-cloud.ts";
import { enviarTemplateGupshup, enviarTextoGupshup } from "./gupshup.ts";
import { canonicoTelefone } from "./telefone.ts";

export type Provedor = "meta" | "gupshup";

export type CanalEnvio =
  | { provedor: "meta"; phoneId: string; token: string }
  | { provedor: "gupshup"; app: string; origem: string; apiKey: string };

// Motivo de nao ter canal, para log e resposta ao front.
export type SemCanal = { provedor: Provedor | null; motivo: "sem_numero" | "numero_incompleto" | "sem_credencial" };

export function provedorDaLinha(linha: any): Provedor {
  return String((linha && linha.provedor) || "meta").toLowerCase() === "gupshup" ? "gupshup" : "meta";
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
  const linha = linhas.find((l) =>
    provedorDaLinha(l) === "gupshup" ? !!l.gupshup_app : !!l.meta_phone_id
  ) || null;
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
  return await enviarTexto({ phoneId: canal.phoneId, token: canal.token, para, texto, prefixoLog });
}

// Modelo aprovado. Meta: {name, language, components}. Gupshup: {id, params}
// (o Gupshup identifica o modelo pelo ID dele, visto no painel).
export type ModeloEnvio = { name?: string; language?: string; components?: unknown[]; id?: string; params?: unknown[] };

export function modeloValido(canal: CanalEnvio, t: ModeloEnvio): boolean {
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
  return await enviarTemplate({
    phoneId: canal.phoneId,
    token: canal.token,
    para,
    template: { name: String(t.name), language: String(t.language || "pt_BR"), components: t.components },
    prefixoLog,
  });
}
