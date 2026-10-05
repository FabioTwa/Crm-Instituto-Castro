// Envio pela WhatsApp Cloud API (Graph API da Meta), usado por
// ic-whatsapp-send (equipe) e ic-ia-pre-atendimento (IA).
//
// POST https://graph.facebook.com/{versao}/{phone_number_id}/messages
// Sucesso: 200 com { messages: [{ id: "wamid...." }] }.
// O wamid devolvido e o MESMO que a Meta manda depois no eco
// (smb_message_echoes); por isso quem grava em crm_conversas guarda esse id em
// zapi_message_id e a trava anti-duplicata do webhook reconhece o eco.
//
// Erros relevantes da Meta (error.code):
//  131047  fora da janela de 24 h (precisa de template)
//  131026  destinatario nao pode receber (numero invalido / nao e WhatsApp)
//  131056  limite de pares (rate)
//  130429  throttling
//  190     token invalido/expirado
//  100     parametro invalido

export const GRAPH_VERSION = "v23.0";

export type EnvioOk = { ok: true; wamid: string; resposta: unknown };
export type EnvioErro = {
  ok: false;
  status: number;
  codigoMeta: number | null;
  mensagemMeta: string;
  foraDaJanela24h: boolean;
  resposta: unknown;
};
export type ResultadoEnvio = EnvioOk | EnvioErro;

async function postMensagem(
  phoneId: string,
  token: string,
  body: Record<string, unknown>,
  prefixoLog: string,
): Promise<ResultadoEnvio> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneId)}/messages`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  let resp: Response;
  let data: any = {};
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      signal: ctl.signal,
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    clearTimeout(t);
    console.error(prefixoLog, "fetch Graph API falhou:", e instanceof Error ? e.message : e);
    return { ok: false, status: 0, codigoMeta: null, mensagemMeta: "falha de conexao", foraDaJanela24h: false, resposta: null };
  }
  clearTimeout(t);

  const wamid = data && Array.isArray(data.messages) && data.messages[0] && data.messages[0].id
    ? String(data.messages[0].id)
    : "";
  if (resp.ok && wamid) return { ok: true, wamid, resposta: data };

  const err = (data && data.error) || {};
  const codigo = err.code != null ? Number(err.code) : null;
  const msg = String(err.message || `Graph API devolveu ${resp.status}`);
  // Nunca logar o token; o corpo de erro da Meta nao traz dados do lead alem do numero.
  console.error(prefixoLog, "Meta nao confirmou envio:", resp.status, codigo, msg.slice(0, 300));
  return {
    ok: false,
    status: resp.status,
    codigoMeta: codigo,
    mensagemMeta: msg,
    foraDaJanela24h: codigo === 131047,
    resposta: data,
  };
}

// Texto livre (dentro da janela de 24 h do lead).
export async function enviarTexto(args: {
  phoneId: string;
  token: string;
  para: string; // numero canonico, so digitos (55DDD9XXXXXXXX)
  texto: string;
  prefixoLog?: string;
}): Promise<ResultadoEnvio> {
  const body = {
    recipient_type: "individual",
    to: args.para,
    type: "text",
    text: { preview_url: false, body: args.texto },
  };
  return await postMensagem(args.phoneId, args.token, body, args.prefixoLog || "[whatsapp-cloud]");
}

// Mensagem de modelo (template aprovado) para falar fora da janela de 24 h.
export async function enviarTemplate(args: {
  phoneId: string;
  token: string;
  para: string;
  template: { name: string; language: string; components?: unknown[] };
  prefixoLog?: string;
}): Promise<ResultadoEnvio> {
  const body = {
    recipient_type: "individual",
    to: args.para,
    type: "template",
    template: {
      name: args.template.name,
      language: { code: args.template.language || "pt_BR" },
      ...(Array.isArray(args.template.components) && args.template.components.length
        ? { components: args.template.components }
        : {}),
    },
  };
  return await postMensagem(args.phoneId, args.token, body, args.prefixoLog || "[whatsapp-cloud]");
}
