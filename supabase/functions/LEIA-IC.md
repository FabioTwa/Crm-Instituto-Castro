# Edge functions do IC CRM (Instituto Castro de Medicina)

Supabase Edge Functions (Deno/TypeScript). Tudo que é segredo vem de
`Deno.env.get(...)`; nenhum valor fica no código. Os módulos de lógica pura
(telefone, regras de handoff, pós-validação, consentimento, horário, crypto) e
de infraestrutura (CORS/JSON, auth, flags, Cloud API, prompt da IA) moram em
`_shared/` e são importados por caminho relativo (`../_shared/x.ts`).

## 1. Funções

| função | quem chama | verify_jwt | segredos que usa (para quê) | deploy |
|---|---|---|---|---|
| `ic-meta-webhook` | Meta (webhook `messages` + `smb_message_echoes`), pg_cron (varredor `{"varredor":true}`) | **não** (assinatura `X-Hub-Signature-256`) | `META_VERIFY_TOKEN` (GET de verificação), `META_APP_SECRET` (assinatura), `META_ACCESS_TOKEN` (baixar áudio), `GROQ_API_KEY` (transcrição), `IC_INTERNAL_SECRET` (chamar a IA) | `supabase functions deploy ic-meta-webhook --no-verify-jwt` |
| `ic-whatsapp-send` | front (`supabaseClient.functions.invoke`) | **sim** + `public.users` ativo | `META_ACCESS_TOKEN` (envio pela Cloud API) | `supabase functions deploy ic-whatsapp-send` |
| `ic-usuarios` | front (tela Usuários → Novo Usuário) | **sim** + `public.users` ativo + Admin | nenhum além dos injetados (usa a service role para `auth.admin.createUser`) | `supabase functions deploy ic-usuarios` |
| `ic-ia-pre-atendimento` | só `ic-meta-webhook` (segundo plano) | **não** (`x-ic-internal`) | `IC_INTERNAL_SECRET` (autoriza e chama `ic-agendamento`), `ANTHROPIC_API_KEY` (modelo), `META_ACCESS_TOKEN` (envio; ausente = modo sombra), `IC_POLITICA_PRIVACIDADE_URL` (link no consentimento) | `supabase functions deploy ic-ia-pre-atendimento --no-verify-jwt` |
| `ic-agendamento` | front (JWT validado em código), `ic-ia-pre-atendimento` (`x-ic-internal`), Google (redirect OAuth, GET) | **não** no gateway, **sim em código** (`auth.getUser` + `public.users` ativo) — ver motivo abaixo | `IC_INTERNAL_SECRET` (interno + assinatura do `state`), `IC_CRYPTO_KEY` (AES-GCM do refresh token), `IC_APP_URL` (link do card, redirect pós-OAuth), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | `supabase functions deploy ic-agendamento --no-verify-jwt` |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetados pelo Supabase em todas.

**Por que `ic-agendamento` sai com `--no-verify-jwt`:** o retorno do OAuth do
Google é um GET do navegador do usuário sem JWT do Supabase; com `verify_jwt`
o gateway devolveria 401 antes do código rodar. Em compensação, toda ação do
front passa por `_shared/auth.ts → usuarioAtivo()`, que valida o JWT de
verdade (`auth.getUser(jwt)`) e exige `public.users.status = 'ativo'`; o
callback é protegido por um `state` assinado (HS256 com `IC_INTERNAL_SECRET`,
10 min). É a mesma garantia, feita em código.

### Contratos para o front

**`ic-whatsapp-send`** (POST, `Authorization: Bearer <jwt do usuário>`)

```jsonc
// texto livre (janela de 24 h aberta)
{ "cliente_crm_id": "<uuid>", "texto": "Olá! ..." }
// modelo aprovado (fora da janela de 24 h)
{ "cliente_crm_id": "<uuid>", "template": { "name": "nome_do_modelo", "language": "pt_BR", "components": [] } }
```

| HTTP | corpo | quando |
|---|---|---|
| 200 | `{ok:true, conversa_id, criada_em, wamid, tipo:'texto'\|'template'}` | enviado e gravado |
| 200 | `{ok:true, conversa_id:null, wamid, aviso:'enviada_sem_registro'}` | Meta confirmou, gravação falhou (o eco grava depois) |
| 400 | `{ok:false, erro:'payload_invalido'\|'texto_invalido'\|'template_invalido'\|'card_sem_numero'\|'card_sem_vendedor'}` | |
| 401/403 | `{ok:false, erro:'sem_token'\|'token_invalido'\|'usuario_nao_cadastrado'\|'usuario_inativo'}` | |
| 403 | `{ok:false, erro:'envio_desligado'}` | flag `envio_whatsapp_cloud_api` desligada |
| 404 | `{ok:false, erro:'card_nao_encontrado'\|'vendedor_sem_cloud_api'}` | vendedor do card sem `meta_phone_id` |
| 409 | `{ok:false, erro:'fora_da_janela_24h'}` | Meta 131047: use `template` |
| 502 | `{ok:false, erro:'meta_recusou'}` | outro erro da Meta (detalhe só no log) |
| 503 | `{ok:false, erro:'envio_nao_configurado'}` | sem `META_ACCESS_TOKEN` |

Dedup com o eco: a Meta devolve a mensagem enviada em `smb_message_echoes`
com o **mesmo wamid**; como gravamos o wamid em `crm_conversas.zapi_message_id`,
o webhook reconhece a repetição (busca + índice único
`crm_conversa_unica_por_instancia`) e não duplica a bolha.

**`ic-agendamento`** (POST, `Authorization: Bearer <jwt>`; retornos `{ok:false, erro}` com 400/401/403/404/500/503)

| ação | body | retorno 200 |
|---|---|---|
| `criar` | `{acao:'criar', cliente_crm_id, inicio (ISO), fim (ISO), responsavel_id?, titulo, tipo?, observacoes?}` | `{ok:true, agendamento_id, google_sync_status, google_sync_erro}` (chama RPC `ic_agendamento_criar`, depois sincroniza) |
| `status` | `{acao:'status', id, status}` | `{ok:true, agendamento_id, status, google_sync_status, google_sync_erro}` (RPC `ic_agendamento_status`; `cancelado` apaga o evento; `confirmado`/`agendado`/`remarcado` cria/atualiza) |
| `sincronizar_pendentes` | `{acao:'sincronizar_pendentes'}` (só admin: `users.role='admin'` ou `perfil` começando com "Admin") | `{ok:true, processados, resultados:{id:status}}` |
| `google_oauth_url` | `{acao:'google_oauth_url'}` | `{ok:true, url}` → abrir em nova aba |
| `google_oauth_callback` | `{acao:'google_oauth_callback', code, state}` (alternativa ao GET) | `{ok:true, email}` |
| (GET) | `?acao=google_oauth_callback&code=&state=` (o Google chama) | redirect 302 para `${IC_APP_URL}/#google=ok` ou `#google=erro&motivo=...` |

Porta interna (header `x-ic-internal`): `{acao:'propor', cliente_crm_id, dia_preferido, periodo:'manha'|'tarde', servico, observacao}` → `{ok:true, confirmado:false, agendamento_id, inicio, fim}`. Cria `agendamentos` com `status='pendente'`, `origem='ia'`, `google_sync_status='desligado'` (só vai ao Google quando um humano confirmar na aba Agendamentos). Se já há proposta pendente da IA para o card, devolve a existente com `repetido:true`.

## 2. Fluxo da IA em 11 etapas (`ic-ia-pre-atendimento`)

Cada etapa grava uma linha em `ia_decisoes_log` (`etapa_pipeline`, `decisao`).

1. **flags** — `ic_flag('ia_pre_atendimento')` e `crm_ia_config.ligada='true'`; senão `desligada`.
2. **humano_assumiu** — há `crm_conversas` `direcao='enviada'`, `autor='vendedor'` nas últimas 24 h (equipe respondeu pelo celular: é a linha que o eco grava) ou `ia_handoffs` com `atendido_em is null` → `humano_no_controle`.
3. **limites** — fora de `horario_inicio`/`horario_fim` (America/Sao_Paulo; sexta até 18h; fim de semana sempre fora): manda o aviso fixo no máximo 1 vez por dia por card (`payload_raw.fora_horario=true`) e encerra. `max_respostas_por_conversa` atingido (conta `ia_decisoes_log.resposta_enviada=true` do card) → handoff `manual` "limite de respostas da IA".
4. **contexto** — RPC `ic_ia_contexto(card, 12)`.
5. **consentimento** — `ia_consentimentos`: pendente e nunca pedido → envia o texto de consentimento (constante em `_shared/ia-prompt.ts`, com `IC_POLITICA_PRIVACIDADE_URL`) e grava `texto_apresentado`; pendente e já pedido → `interpretarConsentimento` (SIM/NÃO/ambíguo): NÃO → `negado` + handoff `consentimento_negado` + despedida; SIM → `concedido`, segue; ambíguo → não responde.
6. **handoff_regras** — `detectarHandoff` (código, antes da IA): urgência (resposta fixa orientando PS/192), dúvida clínica, reclamação, pedido de humano. Grava `ia_handoffs`.
7. **exemplos** — até 8 `ia_exemplos_conversa` ativos, preferindo os cujas `tags` casam com o nome do funil.
8. **claude** — `POST https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`), modelo `crm_ia_config.modelo` (padrão `claude-sonnet-5-5`), `max_tokens` = `crm_ia_config.max_tokens` (padrão 1024), `output_config.effort='low'`, tools `propor_agendamento` e `encaminhar_humano` (`strict:true`, `tool_choice auto`), `AbortController` 25 s. Mensagens do contexto mapeadas lead→user, vendedor/ia→assistant com mesclagem de consecutivas.
9. **pos_validacao** — `respostaProibida` (medicamentos, mg, dose, garantias, "você tem"/"você está com" afirmativos, diagnóstico, receita): bateu → `bloqueada_pos_validacao`, handoff `erro_ia`, resposta fixa neutra.
10. **tools** — `encaminhar_humano` → handoff com o motivo; `propor_agendamento` → `ic-agendamento` `{acao:'propor'}`; se voltar `confirmado:true` grava handoff `agendamento_confirmado` (verificando pendente para não duplicar com o gatilho do banco).
11. **envio** — `_shared/whatsapp-cloud.ts → enviarTexto`; grava `crm_conversas` `autor='ia'`, `direcao='enviada'`, `zapi_message_id`=wamid, `payload_raw={ia:true, modelo, decisao_log_id}`.

### Modo sombra

Se `ic_flag('envio_whatsapp_cloud_api')` for `false`, ou `META_ACCESS_TOKEN`
faltar, ou o vendedor do card não tiver `meta_phone_id`, a IA roda **tudo**
(inclusive a chamada ao modelo) mas não envia nada: a linha de log recebe
`decisao='simulada_envio_desligado'` e a resposta que teria saído fica em
`ia_decisoes_log.detalhe.resposta`. Serve para o time validar as respostas
antes de ligar o envio. O pedido de consentimento simulado é registrado com
`canal='whatsapp_simulado'`.

### Decisões de API (conferidas na skill `claude-api`, 03/10/2026)

- `claude-sonnet-5-5` e `claude-opus-5-5` **rejeitam `temperature` fora do padrão** (HTTP 400) e `tool_choice` forçado; por isso a função não manda `temperature` (a especificação pedia 0.4) e usa `auto` com instrução no prompt.
- Thinking adaptativo fica ligado por padrão e **consome `max_tokens`**; `effort='low'` + `max_tokens` 1024 (não 400) evitam resposta cortada.
- `stop_reason` `refusal`/`max_tokens` ou HTTP ≠ 200 → `erro_ia` + resposta fixa.

## 3. Como ligar cada flag

```sql
update ic_feature_flags set ligada = true where chave = 'ia_transcricao_audio';   -- transcrição Groq no webhook
update ic_feature_flags set ligada = true where chave = 'ia_pre_atendimento';     -- webhook passa a chamar a IA
update crm_ia_config set valor = 'true' where chave = 'ligada';                   -- a IA aceita rodar (as duas são necessárias)
update ic_feature_flags set ligada = true where chave = 'envio_whatsapp_cloud_api'; -- IA e equipe passam a ENVIAR (sai do modo sombra)
update ic_feature_flags set ligada = true where chave = 'agendamento_google';     -- sincroniza agendamentos no Google Calendar
```

Ordem recomendada: `ia_transcricao_audio` → `ia_pre_atendimento` + `ligada`
(modo sombra; ler `ia_decisoes_log` por alguns dias) → `envio_whatsapp_cloud_api`
→ `agendamento_google`. As flags têm cache de 60 s nas funções.

Outras chaves de `crm_ia_config`: `horario_inicio` ('08:00'), `horario_fim`
('19:00'), `max_respostas_por_conversa` ('6'), `modelo`, `max_tokens`.

## 4. Checklist Meta (WhatsApp Cloud API)

No painel da Meta (app com o produto WhatsApp, em modo Live):

a) copie o **Phone number ID** do número e ponha em `vendedores_whatsapp.meta_phone_id`;
b) em Webhooks, URL de retorno `https://<SEU-PROJETO>.supabase.co/functions/v1/ic-meta-webhook` e o mesmo texto do `META_VERIFY_TOKEN`; clique em Verificar;
c) assine os campos `messages` e `smb_message_echoes`. Não assine `history` nem `smb_app_state_sync`;
d) para receber o anúncio de origem, ligue a atribuição de anúncios (Click-to-WhatsApp) na conta;
e) **inscreva cada WABA no app** (passo invisível: sem ele o webhook verifica e nada chega):

```bash
curl -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <TOKEN_DO_USUARIO_DO_SISTEMA>"
```

Confira com `GET https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps`. O `WABA_ID` é o id da conta de WhatsApp, não o Phone number ID.

f) para **enviar** (equipe e IA): o token do usuário do sistema precisa de `whatsapp_business_messaging` e `whatsapp_business_management`; para falar com quem não escreveu nas últimas 24 h, **modelos de mensagem aprovados** (use `template` em `ic-whatsapp-send`).

Se pular (a): o webhook ignora tudo. Se pular (e): nada chega nem em `crm_entrada_bruta`. Se pular `smb_message_echoes`: só o lado do lead entra, e a IA nunca percebe que um humano assumiu.

## 5. Checklist Google OAuth (Calendar)

1. Google Cloud Console → projeto → **APIs e serviços → Biblioteca**: ativar **Google Calendar API**.
2. **Tela de consentimento OAuth**: tipo Interno (Workspace) ou Externo; escopo `https://www.googleapis.com/auth/calendar.events`; adicionar os e-mails da equipe como usuários de teste se o app ficar em "Teste".
3. **Credenciais → ID do cliente OAuth → Aplicativo da Web**. URI de redirecionamento autorizado:
   `https://<SEU-PROJETO>.supabase.co/functions/v1/ic-agendamento?acao=google_oauth_callback`
4. Guardar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REDIRECT_URI` (exatamente a URI acima) como secrets das functions.
5. Gerar `IC_CRYPTO_KEY` (32 bytes em base64): `openssl rand -base64 32`.
6. No CRM, cada responsável clica em "Conectar Google" → o front chama `{acao:'google_oauth_url'}` e abre a `url`; depois do consentimento o Google volta na function, que grava o refresh token cifrado em `ic_google_credenciais` e redireciona para `${IC_APP_URL}/#google=ok`.
7. Ligar `agendamento_google`. Agendamentos de quem ainda não conectou ficam com `google_sync_status='desligado'`; `{acao:'sincronizar_pendentes'}` (admin) reprocessa `pendente`/`erro`.

No Google vai só: nome do lead, telefone, funil/etapa, horário e link do card. Nada clínico.

## 6. Variáveis de ambiente (`supabase secrets set`)

| variável | usada por | para quê |
|---|---|---|
| `SUPABASE_URL` | todas | endereço do projeto (injetada) |
| `SUPABASE_SERVICE_ROLE_KEY` | todas | gravar passando pela RLS (injetada) |
| `META_VERIFY_TOKEN` | ic-meta-webhook | GET de verificação do webhook |
| `META_APP_SECRET` | ic-meta-webhook | conferir `X-Hub-Signature-256` |
| `META_ACCESS_TOKEN` | ic-meta-webhook, ic-whatsapp-send, ic-ia-pre-atendimento | baixar mídia e enviar mensagens pela Graph API |
| `GROQ_API_KEY` | ic-meta-webhook | transcrição de áudio (Whisper) |
| `ANTHROPIC_API_KEY` | ic-ia-pre-atendimento | Messages API da Anthropic |
| `IC_INTERNAL_SECRET` | todas | header `x-ic-internal` entre funções; assinatura do `state` OAuth |
| `IC_CRYPTO_KEY` | ic-agendamento | AES-GCM do refresh token do Google (32 bytes base64) |
| `IC_APP_URL` | ic-agendamento | link do card no evento; redirect pós-OAuth |
| `IC_POLITICA_PRIVACIDADE_URL` | ic-ia-pre-atendimento | link no pedido de consentimento (opcional) |
| `GOOGLE_CLIENT_ID` | ic-agendamento | OAuth / refresh do access token |
| `GOOGLE_CLIENT_SECRET` | ic-agendamento | OAuth / refresh do access token |
| `GOOGLE_REDIRECT_URI` | ic-agendamento | URI de retorno registrada no console |

## 7. Testes

Módulos puros em `_shared/*_test.ts` (`Deno.test` + `jsr:@std/assert`): telefone,
handoff-regras, pos-validacao, consentimento, horario, crypto. Rodar:

```bash
deno test --allow-env --allow-read supabase/functions/_shared/
deno check --node-modules-dir=auto supabase/functions/*/index.ts
```

Limitações documentadas nos testes: regex não entende contexto ("ontem tive
dor forte" ainda dispara urgência; "não é urgente" não dispara); "pode"
sozinho conta como SIM no consentimento (por isso o pedido exige SIM/NÃO).

Os 4 erros de tipo que `deno check` aponta em `ic-meta-webhook/index.ts`
(`Uint8Array` em `crypto.subtle.sign`, `.eq("id", clienteId)` nulo e o tipo do
client nas chamadas) são conhecidos e não afetam o deploy (o bundler do
Supabase não roda o type-check); ficaram como estão para não mexer em regra de
negócio.

## Atribuição de anúncios do Google Ads

O link de WhatsApp dos anúncios do Google leva, no fim do texto pré-preenchido (`?text=`), a marca
`[ic:{campaignid}:{gclid}]` (macros do ValueTrack). O `ic-meta-webhook` lê a marca, grava
`google_campanha_id` e `google_gclid` no card e tira o código do texto antes de gravar a conversa.
