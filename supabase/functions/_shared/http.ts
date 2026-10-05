// CORS e resposta JSON padrao de todas as edge functions do IC CRM.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hub-signature-256, x-ic-internal",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

// Erro para o cliente: mensagem curta e generica, nunca stack. O detalhe vai
// para o console com o prefixo da funcao.
export function erroGenerico(prefixo: string, e: unknown, status = 500): Response {
  console.error(prefixo + " erro:", e instanceof Error ? e.message : e, e instanceof Error ? e.stack : "");
  return json({ ok: false, erro: "erro_interno" }, status);
}
