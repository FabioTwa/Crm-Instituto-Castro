// Criptografia compartilhada (WebCrypto, sem dependencia externa):
// - AES-GCM para guardar o refresh_token do Google em ic_google_credenciais
//   (chave IC_CRYPTO_KEY: 32 bytes em base64).
// - Token assinado HMAC-SHA256 (formato JWT compacto, HS256) para o "state" do
//   OAuth do Google (segredo IC_INTERNAL_SECRET).
// Logica pura: recebe a chave como argumento; quem le o env e a funcao.

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return unb64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function chaveAes(chaveB64: string): Promise<CryptoKey> {
  const raw = unb64(String(chaveB64 || "").trim());
  if (raw.length !== 32) throw new Error("IC_CRYPTO_KEY precisa ter 32 bytes em base64");
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Saida: "v1." + base64url(iv 12 bytes) + "." + base64url(cifra+tag).
export async function cifrar(texto: string, chaveB64: string): Promise<string> {
  const key = await chaveAes(chaveB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(texto));
  return "v1." + b64url(iv) + "." + b64url(new Uint8Array(ct));
}

export async function decifrar(envelope: string, chaveB64: string): Promise<string> {
  const partes = String(envelope || "").split(".");
  if (partes.length !== 3 || partes[0] !== "v1") throw new Error("envelope cifrado invalido");
  const key = await chaveAes(chaveB64);
  const iv = unb64url(partes[1]);
  const ct = unb64url(partes[2]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

async function chaveHmac(segredo: string): Promise<CryptoKey> {
  if (!segredo) throw new Error("segredo HMAC vazio");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Token HS256 curto (header.payload.assinatura). ttlSegundos vira "exp".
export async function assinarToken(payload: Record<string, unknown>, segredo: string, ttlSegundos = 600): Promise<string> {
  const key = await chaveHmac(segredo);
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const agora = Math.floor(Date.now() / 1000);
  const body = b64url(enc.encode(JSON.stringify({ ...payload, iat: agora, exp: agora + ttlSegundos })));
  const assinatura = await crypto.subtle.sign("HMAC", key, enc.encode(header + "." + body));
  return header + "." + body + "." + b64url(new Uint8Array(assinatura));
}

// Devolve o payload se a assinatura bate e nao expirou; senao null.
export async function verificarToken(token: string, segredo: string): Promise<Record<string, unknown> | null> {
  try {
    const partes = String(token || "").split(".");
    if (partes.length !== 3) return null;
    const key = await chaveHmac(segredo);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      unb64url(partes[2]),
      new TextEncoder().encode(partes[0] + "." + partes[1]),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(partes[1])));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_e) {
    return null;
  }
}

// Comparacao em tempo constante para segredos compartilhados (x-ic-internal).
export function iguaisTempoConstante(a: string, b: string): boolean {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
