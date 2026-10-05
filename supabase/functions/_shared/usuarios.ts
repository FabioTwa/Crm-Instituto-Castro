// Validacao pura do cadastro de usuario (ic-usuarios). Mesmas regras de senha
// do front (validatePassword em index.html).

export type NovoUsuario = {
  name: string;
  email: string;
  password: string;
  perfil: string;
  perfil_id: string | null;
  vendedor_responsavel_id: string | null;
  vendedor_responsavel_nome: string | null;
  vendedores_responsaveis_ids: string[] | null;
  telas_permitidas: unknown;
};

export type ResultadoValidacao =
  | { ok: true; dados: NovoUsuario }
  | { ok: false; erro: "payload_invalido" | "senha_fraca" };

const SENHAS_COMUNS = [
  "12345678", "password", "qwerty123", "abc12345", "senha123",
  "admin123", "castro123", "123456789", "instituto2026", "iccrm2026",
];

export function senhaForte(s: string): boolean {
  if (typeof s !== "string" || s.length < 8 || s.length > 72) return false;
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/[0-9]/.test(s) || !/[^A-Za-z0-9]/.test(s)) return false;
  return !SENHAS_COMUNS.includes(s.toLowerCase());
}

function textoOuNulo(v: unknown, max: number): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  return t.length > max ? null : t;
}

export function validarNovoUsuario(p: Record<string, unknown>): ResultadoValidacao {
  const name = String(p.name ?? "").trim();
  const email = String(p.email ?? "").trim().toLowerCase();
  const password = typeof p.password === "string" ? p.password : "";
  const perfil = String(p.perfil ?? "").trim();

  if (!name || name.length > 120) return { ok: false, erro: "payload_invalido" };
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, erro: "payload_invalido" };
  }
  if (!perfil || perfil.length > 60) return { ok: false, erro: "payload_invalido" };
  if (!senhaForte(password)) return { ok: false, erro: "senha_fraca" };

  let ids: string[] | null = null;
  if (p.vendedores_responsaveis_ids != null) {
    if (!Array.isArray(p.vendedores_responsaveis_ids)) return { ok: false, erro: "payload_invalido" };
    ids = p.vendedores_responsaveis_ids.map((x) => String(x)).filter((x) => x.length > 0 && x.length <= 64);
    if (!ids.length) ids = null;
  }

  return {
    ok: true,
    dados: {
      name,
      email,
      password,
      perfil,
      perfil_id: textoOuNulo(p.perfil_id, 64),
      vendedor_responsavel_id: textoOuNulo(p.vendedor_responsavel_id, 64),
      vendedor_responsavel_nome: textoOuNulo(p.vendedor_responsavel_nome, 120),
      vendedores_responsaveis_ids: ids,
      telas_permitidas: p.telas_permitidas ?? null,
    },
  };
}
