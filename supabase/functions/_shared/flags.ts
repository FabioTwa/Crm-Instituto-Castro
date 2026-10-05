// Feature flags (tabela ic_feature_flags, RPC ic_flag) e configuracao da IA
// (crm_ia_config), com cache em memoria do isolate (TTL 60 s).
//
// Chaves de flag: 'envio_whatsapp_cloud_api', 'ia_pre_atendimento',
// 'agendamento_google', 'ia_transcricao_audio'.
// Em caso de erro na consulta a flag e tratada como DESLIGADA: nenhum caminho
// novo roda por acidente quando o banco nao responde.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const TTL_MS = 60 * 1000;
const cacheFlags = new Map<string, { valor: boolean; em: number }>();

export async function icFlag(sb: SupabaseClient, chave: string): Promise<boolean> {
  const c = cacheFlags.get(chave);
  if (c && Date.now() - c.em < TTL_MS) return c.valor;
  try {
    const { data, error } = await sb.rpc("ic_flag", { p_chave: chave });
    if (error) {
      console.warn("[flags] ic_flag falhou para", chave, ":", error.message);
      return c ? c.valor : false;
    }
    const valor = data === true;
    cacheFlags.set(chave, { valor, em: Date.now() });
    return valor;
  } catch (e) {
    console.warn("[flags] excecao em ic_flag", chave, e);
    return c ? c.valor : false;
  }
}

let cacheConfig: { valores: Record<string, string>; em: number } | null = null;

// Le crm_ia_config inteira (poucas linhas). Defaults aplicados aqui.
export async function iaConfig(sb: SupabaseClient): Promise<Record<string, string>> {
  if (cacheConfig && Date.now() - cacheConfig.em < TTL_MS) return cacheConfig.valores;
  const defaults: Record<string, string> = {
    ligada: "false",
    horario_inicio: "08:00",
    horario_fim: "19:00",
    max_respostas_por_conversa: "6",
    modelo: "claude-sonnet-5-5",
    max_tokens: "1024",
  };
  try {
    const { data, error } = await sb.from("crm_ia_config").select("chave, valor");
    if (error) {
      console.warn("[flags] crm_ia_config falhou:", error.message);
      return cacheConfig ? cacheConfig.valores : defaults;
    }
    const valores = { ...defaults };
    for (const r of (data as any[]) || []) {
      if (r && r.chave != null && r.valor != null) valores[String(r.chave)] = String(r.valor);
    }
    cacheConfig = { valores, em: Date.now() };
    return valores;
  } catch (e) {
    console.warn("[flags] excecao em crm_ia_config", e);
    return cacheConfig ? cacheConfig.valores : defaults;
  }
}
