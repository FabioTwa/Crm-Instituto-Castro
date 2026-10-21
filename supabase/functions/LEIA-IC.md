# Edge functions do IC CRM (Instituto Castro de Medicina)

Supabase Edge Functions (Deno/TypeScript). Tudo que é segredo vem de
`Deno.env.get(...)`; nenhum valor fica no código. Os módulos de lógica pura
(telefone, regras de handoff, pós-validação, consentimento, horário, crypto) e
de infraestrutura (CORS/JSON, auth, flags, Cloud API, prompt da IA) moram em
`_shared/` e são importados por caminho relativo (`../_shared/x.ts`).

## 1. Funções

| função | quem chama | verify_jwt | segredos que usa (para quê) | deploy |
|---|---|---|---|---|
| `ic-meta-webhook` | Meta (webhook `messages` + `smb_message_echoes`), Gupshup (`?provedor=gupshup&token=...`), pg_cron (varredor `{"varredor":true}`) | **não** (Meta: assinatura `X-Hub-Signature-256`; Gupshup: token na URL) | `META_VERIFY_TOKEN` (GET de verificação), `META_APP_SECRET` (assinatura), `META_ACCESS_TOKEN` (baixar áudio da Meta), `GUPSHUP_WEBHOOK_TOKEN` (porta do Gupshup), `GUPSHUP_API_KEY` (baixar áudio do Gupshup), `GROQ_API_KEY` (transcrição), `IC_INTERNAL_SECRET` (chamar a IA) | `supabase functions deploy ic-meta-webhook --no-verify-jwt` |
| `ic-whatsapp-send` | front (`supabaseClient.functions.invoke`) | **sim** + `public.users` ativo | `META_ACCESS_TOKEN` ou `GUPSHUP_API_KEY` (conforme o provedor do número) | `supabase functions deploy ic-whatsapp-send` |
| `ic-usuarios` | front (tela Usuários → Novo Usuário) | **sim** + `public.users` ativo + Admin | nenhum além dos injetados (usa a service role para `auth.admin.createUser`) | `supabase functions deploy ic-usuarios` |
| `ic-ia-pre-atendimento` | só `ic-meta-webhook` (segundo plano) | **não** (`x-ic-internal`) | `IC_INTERNAL_SECRET` (autoriza e chama `ic-agendamento`), `ANTHROPIC_API_KEY` (modelo), `META_ACCESS_TOKEN` ou `GUPSHUP_API_KEY` (envio, conforme o provedor do número; ausente = modo sombra), `IC_POLITICA_PRIVACIDADE_URL` (link no consentimento) | `supabase functions deploy ic-ia-pre-atendimento --no-verify-jwt` |
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
// modelo aprovado (fora da janela de 24 h), número na Meta
{ "cliente_crm_id": "<uuid>", "template": { "name": "nome_do_modelo", "language": "pt_BR", "components": [] } }
// modelo aprovado, número no Gupshup (ID do modelo no painel do Gupshup)
{ "cliente_crm_id": "<uuid>", "template": { "id": "<uuid-do-modelo>", "params": ["Maria"] } }
```

O provedor sai de `vendedores_whatsapp.provedor` do número do vendedor do card
(`_shared/whatsapp-envio.ts`). No Gupshup o envio é **assíncrono**: 200 quer
dizer que o Gupshup aceitou; recusa posterior (ex.: código 470, fora da janela
de 24 h) chega no webhook como `message-event` `failed` e fica no log de erro
de `ic-meta-webhook`. O id gravado em `zapi_message_id` é o `messageId` do Gupshup.

| HTTP | corpo | quando |
|---|---|---|
| 200 | `{ok:true, conversa_id, criada_em, wamid, tipo:'texto'\|'template'}` | enviado e gravado |
| 200 | `{ok:true, conversa_id:null, wamid, aviso:'enviada_sem_registro'}` | Meta confirmou, gravação falhou (o eco grava depois) |
| 400 | `{ok:false, erro:'payload_invalido'\|'texto_invalido'\|'template_invalido'\|'card_sem_numero'\|'card_sem_vendedor'}` | |
| 401/403 | `{ok:false, erro:'sem_token'\|'token_invalido'\|'usuario_nao_cadastrado'\|'usuario_inativo'}` | |
| 403 | `{ok:false, erro:'envio_desligado'}` | flag `envio_whatsapp_cloud_api` desligada |
| 404 | `{ok:false, erro:'card_nao_encontrado'\|'vendedor_sem_cloud_api'}` | número do vendedor sem `meta_phone_id` (Meta) ou sem `gupshup_app` (Gupshup) |
| 409 | `{ok:false, erro:'fora_da_janela_24h'}` | Meta 131047: use `template` (no Gupshup a recusa vem depois, pelo webhook) |
| 502 | `{ok:false, erro:'meta_recusou'\|'gupshup_recusou'\|'zapi_recusou'}` | o provedor recusou (detalhe só no log) |
| 503 | `{ok:false, erro:'envio_nao_configurado'}` | sem `META_ACCESS_TOKEN` / `GUPSHUP_API_KEY` |

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

## 2. Fluxo da IA em 12 etapas (`ic-ia-pre-atendimento`)

Cada etapa grava uma linha em `ia_decisoes_log` (`etapa_pipeline`, `decisao`).

Desde o SQL 37 a IA é a **Julie** (`persona_nome`, `persona_ficha`) e atende o
lead **até o agendamento**: responde a qualquer hora (`atender_fora_do_horario`),
espera 30 s sem mensagem nova antes de responder (`rajada_silencio_segundos`,
teto `rajada_teto_segundos`), lê as últimas 30 mensagens (`contexto_mensagens`),
informa valores, reserva o horário sem conflito na agenda e avisa pelo WhatsApp
quem confirma com o lead (`aviso_agendamento_whatsapp`). Faz **um envio por
vez** no número (`atender_um_por_vez`, trava `ia_vez`): as conversas andam juntas
(espera e geração da resposta), mas só uma resposta sai por vez; quem não pega a
vez em `fila_espera_segundos` vai para a equipe. A vez fica presa até o "digitando…" terminar e, se a trava não puder ser lida, nada é enviado. Não há limite de mensagens por
lead por dia (decisão de 21/10/2026). Manda cada parágrafo da resposta como uma mensagem separada, com "digitando…".
A conversa nunca é encerrada por inatividade e, por decisão de 21/10/2026, lead
que para de responder não recebe retomada (`followups_minutos` vazio).
Se perguntarem a sério se é robô, ela confirma; não conta história de saúde
própria (CFM 2.336/2023).

1. **flags** — `ic_flag('ia_pre_atendimento')` e `crm_ia_config.ligada='true'`; senão `desligada`.
2. **humano_assumiu** — há `crm_conversas` `direcao='enviada'`, `autor='vendedor'` nas últimas 24 h (equipe respondeu pelo celular: é a linha que o eco grava) → `humano_no_controle`. Com `ia_handoffs` `atendido_em is null` (equipe já chamada) e o lead escrevendo de novo: manda `TEXTO_AVISO_ESPERA` ("nossa equipe já foi avisada…") **uma vez por handoff** (`decisao='aviso_espera'`), depois fica em silêncio até a equipe atender ou clicar em Encerrar conversa.
3. **limites** — só com `atender_fora_do_horario='false'`: fora de `horario_inicio`/`horario_fim` (America/Sao_Paulo; sexta até 18h; fim de semana sempre fora): manda o aviso fixo no máximo 1 vez por dia por card (`payload_raw.fora_horario=true`) e encerra. `max_respostas_por_conversa` atingido (conta `ia_decisoes_log.resposta_enviada=true` do card desde o último encerramento por inatividade) → handoff `manual` "limite de respostas da IA".
4. **contexto** — RPC `ic_ia_contexto(card, contexto_mensagens)` (padrão 30).
5. **consentimento** — `ia_consentimentos`: pendente e nunca pedido → envia o texto de consentimento (constante em `_shared/ia-prompt.ts`, com `IC_POLITICA_PRIVACIDADE_URL`) e grava `texto_apresentado`; pendente e já pedido → `interpretarConsentimento` (SIM/NÃO/ambíguo): NÃO → `negado` + handoff `consentimento_negado` + despedida; SIM → `concedido`, segue; ambíguo → não responde.
6. **handoff_regras** — `detectarHandoff` (código, antes da IA): urgência (resposta fixa orientando PS/192), dúvida clínica, reclamação, pedido de humano. Grava `ia_handoffs`.
7. **exemplos** — até 12 `ia_exemplos_conversa` ativos, preferindo os cujas `tags` casam com o nome do funil.
8. **claude** — `POST https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`), modelo `crm_ia_config.modelo` (padrão `claude-sonnet-5-5`), `max_tokens` = `crm_ia_config.max_tokens` (padrão 1024), `output_config.effort='low'`, tools `propor_agendamento` e `encaminhar_humano` (`strict:true`, `tool_choice auto`), `AbortController` 25 s. Mensagens do contexto mapeadas lead→user, vendedor/ia→assistant com mesclagem de consecutivas.
9. **pos_validacao** — `respostaProibida` (medicamentos, mg, dose, garantias, "você tem"/"você está com" afirmativos, diagnóstico, receita): bateu → `bloqueada_pos_validacao`, handoff `erro_ia`, resposta fixa neutra.
10. **tools** — antes: se o lead mandou mensagem nova enquanto a IA pensava, esta invocação desiste (`rajada/absorvida_depois_da_ia`) e a da mensagem nova responde tudo junto. `encaminhar_humano` → handoff com o motivo; `propor_agendamento` (serviço, dia, horário, nome completo, formato, pagamento) → `ic-agendamento` `{acao:'propor'}` reserva o horário (status `pendente`; recusa horário com `agenda_vagas_por_horario` agendamentos e devolve 2 sugestões, que viram a resposta). Reservou: handoff `agendamento_confirmado` (a equipe confirma; a IA segue respondendo o lead, ver `handoffCalaIA`) e aviso no WhatsApp de cada número de `aviso_agendamento_whatsapp` (`tools/aviso_equipe_enviado`; vazio = `aviso_equipe_sem_numero`).
11. **envio** — `_shared/whatsapp-envio.ts → enviarTextoCanal` (Meta ou Gupshup, pelo provedor do número); grava `crm_conversas` `autor='ia'`, `direcao='enviada'`, `zapi_message_id`=wamid, `payload_raw={ia:true, modelo, decisao_log_id}`.
12. **funil** — RPC `ic_avancar_etapa` (SQL 33), só para frente e nunca em fechado/perdido/cliente antigo: IA respondeu de verdade → `em_conversa`; lead perguntou valor, preço, convênio, parcelamento, online/presencial (`_shared/funil-ia.ts → detectarNegociacao`) → `negociacao` / `negociacao_quente`; IA propôs horário → `agendamento_pendente` / `avaliacao_inicial`. Funil sem a etapa: nada muda. Cada movimento grava `crm_historico` tipo `automatico` (autor "Assistente virtual") e `ia_decisoes_log` `funil/etapa_avancada`. Desligar: `crm_ia_config.funil_automatico='false'`. A confirmação do agendamento pela equipe (gatilho do SQL 18, agora via a mesma RPC) leva a `visita_confirmada` / `consulta_agendada` / `avaliacao_inicial`.

### Modo sombra

Se `crm_ia_config.modo_sombra` não for `'false'` (padrão `'true'`), ou
`ic_flag('envio_whatsapp_cloud_api')` for `false`, ou faltar a credencial
do provedor (`META_ACCESS_TOKEN` / `GUPSHUP_API_KEY`), ou o número do vendedor
do card não estiver configurado (`meta_phone_id` / `gupshup_app`), a IA roda **tudo**
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
('19:00'), `max_respostas_por_conversa` ('80' desde o SQL 37), `modelo`, `max_tokens`,
e as do SQL 37 (Julie): `persona_nome`, `persona_ficha`, `rajada_silencio_segundos`,
`rajada_teto_segundos`, `atender_fora_do_horario`, `contexto_mensagens`,
`followups_minutos`, `followup_horario`, `aviso_agendamento_whatsapp`,
`agenda_vagas_por_horario`, `atender_um_por_vez`, `fila_espera_segundos`.

### Retomadas (follow-up), SQL 37 — desligadas

`followups_minutos` (vazio = desligado, o padrão; '120,1440,4320' = 2 h, 1 dia e
3 dias desde que a conversa parou) e `followup_horario`
('08:00-20:00', nunca domingo). O varredor chama `{acao:'encerrar_inativas'}`
1x por minuto; com retomadas ligadas, a função procura cards em que a IA falou
por último, sem handoff pendente e com consentimento concedido, e manda no
máximo 3 por rodada. A própria IA escreve a retomada lendo a conversa (sem
ferramentas, com pós-validação); se falhar, vai um texto fixo de
`_shared/ia-followup.ts`. Cada retomada grava `crm_conversas.payload_raw.followup=true`
e `ia_decisoes_log` `followup/followup_enviado`. Lead ou vendedor falou por
último: nada. Depois da última retomada a IA espera o lead.

### Encerramento por inatividade

Só vale com `followups_minutos` vazio (desde o SQL 37 fica em '0': nunca encerra). `encerrar_apos_minutos` (padrão '60' sem linha na tabela; '0' desliga; 5 a 1440).
Quando a IA foi a última a falar e o lead não responde nesse prazo, a conversa é
encerrada: dentro do horário de atendimento (e da janela de 24 h do WhatsApp)
sai a despedida fixa `TEXTO_ENCERRAMENTO` (`payload_raw.encerramento=true`);
fora dele, encerra sem mensagem. Fica uma linha em `ia_decisoes_log` com
`etapa_pipeline='encerramento'`. A próxima mensagem do lead abre conversa nova
e o `max_respostas_por_conversa` volta a contar do zero. Não encerra card com
handoff pendente nem quando o vendedor falou por último.
A equipe também encerra pelo botão **Encerrar conversa** (painel do lead e
card completo). O front chama `ic-ia-pre-atendimento` com
`{acao:'encerrar_conversa_equipe', cliente_crm_id}` e o JWT do usuário (única
ação sem `x-ic-internal`; JWT validado em código por `usuarioAtivo`). A função
roda a RPC `ic_encerrar_conversa` (SQL 32) **como o usuário** (usuário ativo e
card no escopo), que fecha os handoffs pendentes e grava
`decisao='encerrada_pela_equipe'`; depois, se a IA está ligada, atende o
número e o lead escreveu nas últimas 24 h, manda `TEXTO_ENCERRAMENTO`
(`decisao='encerrada_pela_equipe_com_mensagem'`). Depois de qualquer
encerramento, mensagem antiga do vendedor não cala mais a IA.
Quem dispara: o varredor do `ic-meta-webhook` (pg_cron de 30 s), 1x por minuto,
com `{acao:'encerrar_inativas'}` e `x-ic-internal`. Lógica em
`_shared/ia-encerramento.ts`.

```sql
insert into crm_ia_config (chave, valor, descricao)
values ('encerrar_apos_minutos', '60', 'IC: minutos sem resposta do lead para encerrar a conversa (0 desliga)')
on conflict (chave) do update set valor = excluded.valor;
```

### Fase de teste no número real (SQL 29)

`modo_sombra` ('true' = a IA não envia nada; só `'false'` libera) e
`numeros_teste` (telefones separados por vírgula; preenchida = a IA só atende
esses números, os demais leads ficam com `decisao='fora_dos_numeros_teste'`).
A equipe continua enviando normalmente. Roteiro para treinar no número de
coexistência sem a IA falar com paciente:

```sql
update crm_ia_config set valor = '11999990000, 11988880000' where chave = 'numeros_teste'; -- celulares da equipe
update crm_ia_config set valor = 'false' where chave = 'modo_sombra';  -- a IA responde, mas só a esses números
update ic_feature_flags set ligada = true where chave = 'ia_pre_atendimento';
update crm_ia_config set valor = 'true' where chave = 'ligada';
```

Para conversar de novo com o mesmo número depois de um handoff, marque o
handoff como atendido (Ações do Dia) e lembre que resposta da equipe nas
últimas 24 h faz a IA ficar calada nesse card.

Revisar o que a IA decidiu e respondeu:

```sql
select criado_em, etapa_pipeline, decisao, motivo, tokens_entrada, tokens_saida,
       detalhe->>'resposta' as resposta
from ia_decisoes_log order by criado_em desc limit 50;
```

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

## 4b. Checklist Gupshup (coexistência)

Caminho recomendado para o número real: o Gupshup faz a conexão por QR code e
o número continua no WhatsApp Business App do celular.

1. **SQL 28** aplicado (`supabase/sql/28_ic_whatsapp_gupshup.sql`) **antes** de publicar as funções.
2. Segredos (painel do Supabase → Edge Functions → Secrets, ou `supabase secrets set`):
   - `GUPSHUP_API_KEY` = chave da conta no Gupshup;
   - `GUPSHUP_WEBHOOK_TOKEN` = texto longo e aleatório criado por você (`openssl rand -hex 32`).
3. Publicar `ic-meta-webhook` (`--no-verify-jwt`), `ic-whatsapp-send` e `ic-ia-pre-atendimento`.
4. No painel do Gupshup → app → **Webhooks**: URL
   `https://<SEU-PROJETO>.supabase.co/functions/v1/ic-meta-webhook?provedor=gupshup&token=<GUPSHUP_WEBHOOK_TOKEN>`.
   Os dois formatos funcionam (Gupshup v2 e Meta v3). Escolha **um só** para as
   mensagens: com os dois ligados, a mesma mensagem pode chegar duas vezes.
   Ligue também os eventos de coexistência (eco das mensagens enviadas pelo
   celular): sem eles a IA não percebe que um humano assumiu.
5. Ligar o número no CRM (SQL Editor, trocando os `< >`):

```sql
update public.vendedores_whatsapp
set provedor = 'gupshup', gupshup_app = '<NOME_DO_APP_NO_GUPSHUP>', numero_whatsapp = '<5511900000000>'
where vendedor_id = '<ID_DO_VENDEDOR>';
```

   `gupshup_app_id` (o `gs_app_id` que aparece nos eventos formato Meta) é opcional: no formato
   Meta (v3) o evento não traz o nome do app, e o webhook acha o número por `gs_app_id`,
   `meta_phone_id` ou, na falta deles, pelo próprio `numero_whatsapp` (`display_phone_number`).
6. Teste: mandar uma mensagem de outro celular para o número → card novo no
   Kanban; conferir `crm_entrada_bruta` (origem `gupshup`) e o log da função.

Segurança: o Gupshup **não documenta assinatura** de webhook. A porta só aceita
chamadas com o `token` certo na URL (comparação em tempo constante); sem
`GUPSHUP_WEBHOOK_TOKEN` configurado, tudo é recusado. Quem tiver a URL completa
consegue mandar eventos falsos: trate a URL como senha e troque o token se ela
vazar (novo valor no segredo + nova URL no painel).

Mídia: no formato v2 o áudio vem com link (baixado direto; a API key só é
mandada para `*.gupshup.io`); no formato Meta/coexistência vem só o id, baixado
em `https://api.gupshup.io/sm/api/wamedia/{app}/{id}` (endpoint do artigo de
suporte do Gupshup: conferir em homologação).

## 4c. Checklist Z-API (só para o treino da IA)

⚠️ A Z-API **não é API oficial** da Meta: conecta o número como aparelho do
WhatsApp Web. Há risco de banimento do número. Use só no treino da IA; a
produção segue no Gupshup.

1. **SQL 31** aplicado (`supabase/sql/31_ic_whatsapp_zapi.sql`) **antes** de publicar as funções.
2. Segredos (Edge Functions → Secrets):
   - `ZAPI_INSTANCE_TOKEN` = token da instância (painel Z-API → Instâncias);
   - `ZAPI_CLIENT_TOKEN` = token de segurança da conta (painel Z-API → Segurança);
   - `ZAPI_WEBHOOK_TOKEN` = texto longo e aleatório criado por você.
3. Publicar `ic-meta-webhook` (`--no-verify-jwt`), `ic-whatsapp-send` e `ic-ia-pre-atendimento`.
4. No painel da Z-API → instância → **Webhooks**, campo **Ao receber**:
   `https://<SEU-PROJETO>.supabase.co/functions/v1/ic-meta-webhook?provedor=zapi&token=<ZAPI_WEBHOOK_TOKEN>`
   e ligar **Notificar as enviadas por mim também** (sem isso a IA não percebe
   que alguém da equipe respondeu pelo celular).
5. Ligar o número no CRM (o `id` da linha em `vendedores_whatsapp`):

```sql
update public.vendedores_whatsapp
set provedor = 'zapi', zapi_instancia = '<ID_DA_INSTANCIA>', numero_whatsapp = '<5511900000000>'
where id = '<ID_DA_LINHA>';
```

   Um número tem um provedor ativo só: com `provedor = 'zapi'` a linha deixa de
   ser achada pelos webhooks da Meta e do Gupshup. Voltar: `set provedor = 'gupshup'`.
6. Teste: mandar "Oi" de outro celular → card no Kanban e `crm_entrada_bruta` com origem `zapi`.

Detalhes: a Z-API não assina o webhook (a porta só aceita o `token` certo na
URL). Mensagens enviadas pela própria API (`fromApi`) são ignoradas, porque o
CRM já gravou o que enviou. Grupos, canais, listas de transmissão e outros
callbacks também. Áudio vem com link direto (baixado sem credencial). Não há
modelo (template): `ic-whatsapp-send` responde `template_invalido`.

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
| `META_ACCESS_TOKEN` | ic-meta-webhook, ic-whatsapp-send, ic-ia-pre-atendimento | baixar mídia e enviar mensagens pela Graph API (números `meta`) |
| `GUPSHUP_API_KEY` | ic-meta-webhook, ic-whatsapp-send, ic-ia-pre-atendimento | baixar mídia e enviar mensagens pelo Gupshup (números `gupshup`) |
| `GUPSHUP_WEBHOOK_TOKEN` | ic-meta-webhook | segredo na URL do webhook do Gupshup |
| `ZAPI_INSTANCE_TOKEN` | ic-whatsapp-send, ic-ia-pre-atendimento | token da instância da Z-API (números `zapi`) |
| `ZAPI_CLIENT_TOKEN` | ic-whatsapp-send, ic-ia-pre-atendimento | header `Client-Token` (token de segurança da conta Z-API) |
| `ZAPI_WEBHOOK_TOKEN` | ic-meta-webhook | segredo na URL do webhook da Z-API |
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
handoff-regras, pos-validacao, consentimento, horario, crypto, gupshup (conversão
do webhook, corpo do envio, mídia) e whatsapp-envio (escolha do provedor). Rodar:

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
