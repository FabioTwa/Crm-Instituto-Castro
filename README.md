# IC CRM — Instituto Castro de Medicina

CRM de atendimento e pipeline de vendas da clínica, com WhatsApp Business API
(Coexistence) espelhado nos cards, assistente virtual de pré-atendimento
(Claude) e agendamento integrado ao Google Agenda.

O sistema é uma página única (HTML, CSS e JS vanilla, sem build) sobre Postgres no
Supabase, com a lógica de negócio no banco (funções SQL, gatilhos e RLS).

## Stack (fixa)

| camada | o que é |
|---|---|
| Front | `index.html` único, vanilla, sem build. CSS e JS dentro dele + `encaixes.js`, `encaixes-depois.js`, `ic-extensoes.js` |
| Banco | Postgres no Supabase: `supabase/sql/00`–`27`, aplicados em ordem |
| Servidor | Supabase Edge Functions (Deno/TS): `supabase/functions/` |
| Hospedagem | Vercel (site estático montado por `ferramentas/montar-site.mjs`, `vercel.json` com CSP) |

## Estrutura

```
index.html                 tela única (login, Kanban, card, conversa, Leads, Ações do Dia, Agendamentos, Usuários, Permissões...)
ic-extensoes.js            código do IC CRM (temperatura, telefone, agendamentos, handoffs, flags, CSV, roteador, cadastro)
encaixes.js                placeholders da camada de vendas (fora de escopo) e aba Vendas vazia
encaixes-depois.js         rotas de telas que não existem -> Kanban
assets/logo-instituto-castro.svg
config.example.js          copiar para config.js (URL + chave anon). config.js NÃO vai para o git
ferramentas/               aplicar-tema-ic.mjs + tema-ic.css: identidade visual (tokens e verificações); auditar-xss.mjs e auditar-textos.mjs
supabase/sql/              00–12 esquema base · 13 perfis/funis/telas · 14 dinheiro+flags · 15 RLS · 16 jobs · 17 IA · 18 agendamentos · 19 reserva vendas · 20 apoio front · 21 funis · 22 realtime do histórico · 23 cadastro padronizado · 24 limites de texto · 25 usuários só no Auth · 26 funções fora do anon · 27 Admin protegido · LEIA-IC.md
supabase/functions/        ic-meta-webhook · ic-whatsapp-send · ic-ia-pre-atendimento · ic-agendamento · ic-usuarios · _shared/ · LEIA-IC.md
teste/testar-na-base-vazia.mjs   sobe 00–27 num Postgres local (PGlite) e testa funções, RLS por papel e jobs
docs/                      validações e documentos do projeto (prints e relatórios por correção)
```

## Subir do zero

1. Projeto Supabase novo. Em **SQL Editor**, rode `supabase/sql/00` a `27`, um por vez, na ordem
   (no `11`, troque `<SEU-PROJETO>`; no `12`, os valores `< >`). Leia `supabase/sql/LEIA-IC.md`.
2. Crie o primeiro usuário em Authentication → Users e a linha em `public.users` com `pw = 'supabase_auth'`
   (bloco comentado no fim do `13_ic_perfis_e_parametros.sql`).
3. Publique as Edge Functions e cadastre os segredos (lista e comandos em `supabase/functions/LEIA-IC.md`).
4. Vercel: importe este repositório e cadastre as variáveis `SUPABASE_URL` e `SUPABASE_ANON_KEY` (chave **anon**).
   O build (`ferramentas/montar-site.mjs`, chamado pelo `vercel.json`) gera o `config.js` a partir delas e publica
   só o front na pasta `site/`. SQL, Edge Functions, docs, testes e demonstração não vão para o site.
   O build aborta se faltar variável ou se a chave não for a anon.
   Para rodar local sem a Vercel: `cp config.example.js config.js` e preencha.
5. WhatsApp: siga o checklist da Meta em `supabase/functions/LEIA-IC.md` (número em coexistência por QR code,
   webhook em `/functions/v1/ic-meta-webhook`, WABA inscrita no app, `meta_phone_id` em `vendedores_whatsapp`).

## Variáveis de ambiente (só os nomes; modelo em `.env.example`)

Cadastradas nas Edge Functions com `supabase secrets set NOME=valor`. Nunca vão para o git nem para o front.

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (injetadas pelo Supabase) · `META_VERIFY_TOKEN`, `META_APP_SECRET`,
`META_ACCESS_TOKEN` · `GROQ_API_KEY` · `ANTHROPIC_API_KEY`, `IC_POLITICA_PRIVACIDADE_URL` · `IC_INTERNAL_SECRET`,
`IC_CRYPTO_KEY`, `IC_APP_URL` · `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

O front lê só `config.js` (URL do projeto e chave **anon**, que é pública por desenho). A `service_role` nunca entra ali.

## Feature flags (tabela `ic_feature_flags`, só Admin altera)

| chave | padrão | liga |
|---|---|---|
| `ia_transcricao_audio` | true | transcrição de áudio no webhook (Groq Whisper) |
| `envio_whatsapp_cloud_api` | false | envio de mensagem pela tela do CRM (Cloud API) |
| `ia_pre_atendimento` | false | assistente virtual (roda em modo sombra enquanto o envio estiver desligado) |
| `agendamento_google` | false | sincronização com o Google Agenda |

## Testes

```bash
cd teste && npm init -y && npm i @electric-sql/pglite && node testar-na-base-vazia.mjs ../supabase/sql
```

```bash
cd supabase/functions && deno test --allow-env --allow-read _shared/
```

## Regras de negócio que valem saber

- Primeira etapa de todo funil é `cliente_novo`; existe sempre `cliente_antigo`; ganho é `fechado`. São chaves (`crm_funil_etapas.nome`), o rótulo é `label`.
- Lead em `cliente_novo` há mais de 30 dias vira `cliente_antigo` por **job diário do banco** (`crm_reclassificar_antigos`, 03:00 BRT), com linha na timeline. O Kanban só avisa.
- Arrastar um card para fora de "Fechado" reabre e desativa negociações; mudar a etapa pelo dropdown do card não desativa. Os dois caminhos existem de propósito.
- Um telefone, um card por funil: índice único no banco.
- "Ver valores financeiros" (`perfis_acesso.ve_dinheiro`) é o único interruptor de dinheiro; verificado no banco por `ic_pode_ver_dinheiro()`.
- Mídia (imagem/vídeo/documento) não é baixada: só tipo + placeholder. Áudio é transcrito.
- IA: handoff para humano decidido em código antes de qualquer chamada ao modelo; nunca diagnostica, indica medicação ou promete resultado; consentimento LGPD pedido na primeira conversa; toda decisão em `ia_decisoes_log`.

## Modo demonstração local (só para teste)

Sem Supabase, dá para validar o front inteiro com dados fictícios. O banco real do projeto
(`supabase/sql/00`–`27`) roda dentro do navegador via PGlite; só o login e a camada REST são simulados
(`demo/demo-local.js`). Liga apenas em `localhost` e apenas se o `config.js` local tiver o bloco
`DEMO_LOCAL` (o `config.js` não vai para o git e `demo/` não vai para a Vercel, ver `.vercelignore`).

1. Preencha `DEMO_LOCAL` no `config.js` (e-mail, nome e senha de um Admin e de um Atendente de teste).
2. Sirva a pasta por HTTP e abra no navegador:

```bash
npx http-server . -p 5500 -c-1
```

3. Entre com o Admin para ver tudo (inclusive valores em R$) e com o Atendente para conferir que o dinheiro some.

Limites: sem RLS por usuário (o navegador é dono do banco), sem Edge Functions (envio de WhatsApp e Google ficam
desligados) e dados em memória, que voltam ao estado inicial ao recarregar.

## Auditoria de campos

Tabela por tela (campo, problema, correção) em `docs/validacao-lote2/README.md`. Testes das funções puras: `node teste/testar-validacao.mjs`. Heurística de XSS: `node ferramentas/auditar-xss.mjs index.html ic-extensoes.js`.
