# IC CRM: banco de dados

O banco do IC CRM e Postgres no Supabase, montado por 28 arquivos SQL numerados
(`00_` a `27_`) que se aplicam em ordem. Os arquivos `00_` a `12_` sao o esquema
base: extensoes, tabelas, funcoes do nucleo do CRM, views, gatilhos, politicas
iniciais, realtime, o varredor do webhook e parametros de exemplo. Os arquivos
`13_` a `27_` sao as camadas do IC CRM (perfis, dinheiro, RLS, jobs, IA, agenda,
funis, cadastro), cada um com cabecalho e, quando altera algo existente, um bloco
`-- ROLLBACK:` no fim. O `11_agendamentos.sql` agenda o varredor do webhook
(`ic-meta-webhook`); troque `<SEU-PROJETO>` antes de rodar.

## Ordem de execucao

No Supabase, SQL Editor, um arquivo por vez:

| arquivo | o que faz | depende de |
|---|---|---|
| `00` a `10` | esquema base: extensoes, funcoes base, tabelas, encaixe de vendas, chaves estrangeiras, indices, funcoes do nucleo, views, gatilhos, politicas iniciais, realtime | |
| `11_agendamentos.sql` | varredor do webhook (pg_cron + pg_net). Trocar `<SEU-PROJETO>` | |
| `12_parametros_exemplo.sql` | OPCIONAL. Perfis/telas/funil de EXEMPLO. O 13 convive com ele (apaga o 'Funil EXEMPLO', atualiza perfis e telas) | |
| `13_ic_perfis_e_parametros.sql` | `perfis_acesso.rotulo` e `.ve_dinheiro`; 4 perfis; 10 telas; permissoes padrao; 3 funis; metas; IA desligada | 02, 04 |
| `14_ic_permissao_dinheiro.sql` | `ic_feature_flags`; `ic_usuario_atual()`, `ic_eh_admin()`, `ic_perfil_nome()`, `ic_pode_ver_dinheiro()`, `ic_flag()`; RPCs de dinheiro `ic_*` | 13 |
| `15_ic_rls.sql` | fecha a RLS: derruba as politicas `using (true)` do 09 e recria por perfil | 13, 14 |
| `16_ic_jobs.sql` | `crm_reclassificar_antigos()` (regra dos 30 dias como job), `ic_jobs_log`, pg_cron 03:00 BRT, auditoria em users/perfis/permissoes | 13, 15 |
| `17_ic_ia.sql` | IA de pre-atendimento: consentimento, log de decisao, handoffs, exemplos; `ic_ia_contexto()` | 14, 15 |
| `18_ic_agendamentos.sql` | `agendamentos`, `ic_google_credenciais`, gatilho de confirmacao, RPCs, realtime | 13, 14, 15, 17 |
| `19_ic_reserva_vendas.sql` | so comentario: onde a camada de venda vai se encaixar | 03 |
| `20_ic_apoio_front.sql` | `ic_ultimas_mensagens(uuid[])`: previa da ultima mensagem nos cards do Kanban | 15 |
| `21_ic_funis.sql` | exclusao de funil: `ic_funil_resumo`, `ic_funil_excluir` (so Admin, transacional, exclusao logica), colunas `excluido_em`/`excluido_por`, auditoria de `crm_funis` | 14, 15, 16 |
| `22_ic_historico_realtime.sql` | publica `crm_historico` no Realtime (anotacao de outro usuario aparece sem recarregar); idempotente, com rollback no rodape | 02 |
| `23_ic_cadastro_padrao.sql` | CPF (`ic_cpf_valido`), e-mail e origem (lista oficial, chave estavel) validados no banco; cópia em `ic_bkp23_cadastro`, pendencias em `ic_cadastro_pendencias`; rollback no rodape | 02, 08 |
| `24_ic_limites_de_texto.sql` | limites de tamanho (nome 200, profissao 100, observacoes 5000, funil 100) como CHECK NOT VALID; rollback no rodape | 02 |
| `25_ic_usuarios_auth.sql` | `users.pw` so aceita `'supabase_auth'` (senha mora so no Supabase Auth, criada pela function `ic-usuarios`); trigger `ic_users_protege_campos`: quem nao e Admin so altera nome, foto e iniciais da propria linha; rollback no rodape | 14, 15 |
| `26_ic_funcoes_sem_anon.sql` | `crm_cards_irmaos` e `crm_mescla_resumo` (SECURITY DEFINER) so para authenticated/service_role; `ic_agendamento_confirmado` (gatilho) fora da API; rollback no rodape | 06, 18 |
| `27_ic_admin_protegido.sql` | gatilho `ic_users_protege_admin`: ninguem altera o proprio perfil/papel/status pelo app, e nenhuma alteracao ou exclusao deixa o sistema sem Admin ativo (sem JWT, SQL Editor, passa: caminho de recuperacao); rollback no rodape | 14, 25 |

Depois do 13, inserir o primeiro usuario (criado antes no Supabase Auth, mesmo
e-mail) e o numero de WhatsApp: o bloco comentado no fim do 13 mostra como.
`users.pw` recebe `'supabase_auth'`, nunca senha.

## Contratos (nomes que o front ja usa)

### Tabelas novas
| tabela | arquivo | para que |
|---|---|---|
| `ic_feature_flags (chave pk, ligada, descricao, atualizada_em, atualizada_por)` | 14 | flags: `envio_whatsapp_cloud_api`, `ia_pre_atendimento`, `agendamento_google`, `ia_transcricao_audio` |
| `ic_jobs_log (id, job, executado_em, afetados, detalhe)` | 16 | um resumo por execucao de job |
| `ia_consentimentos` | 17 | status `pendente/concedido/negado/revogado` por card |
| `ia_decisoes_log` | 17 | toda decisao da IA; `dados_enviados_resumo` so conta, nunca conteudo |
| `ia_handoffs` | 17 | fila IA -> humano; `atendido_em is null` = pendente |
| `ia_exemplos_conversa` | 17 | exemplos anonimizados para o prompt; nasce vazia |
| `agendamentos` | 18 | consultas; `status`, `origem`, `google_*` |
| `ic_google_credenciais` | 18 | refresh token cifrado; sem select para `authenticated` |

### Colunas novas em tabelas existentes
`perfis_acesso.rotulo text`, `perfis_acesso.ve_dinheiro boolean` (13).
`crm_funis.excluido_em timestamptz`, `crm_funis.excluido_por text` (21). Funil excluido tem `ativo = false` e `excluido_em` preenchido; as telas filtram por `excluido_em is null`.

### Funcoes
| funcao | retorno | quem chama | arquivo |
|---|---|---|---|
| `ic_usuario_atual()` | `users` | authenticated | 14 |
| `ic_eh_admin()` | boolean | authenticated, anon (false) | 14 |
| `ic_perfil_nome()` | text | authenticated | 14 |
| `ic_pode_ver_dinheiro()` | boolean | authenticated; service_role = true; anonimo = false | 14 |
| `ic_flag(p_chave text)` | boolean | authenticated | 14 |
| `ic_atendimento_resumo(p_inicio date, p_fim date, p_vendedores text[])` | jsonb, mesma forma de `crm_atendimento_resumo` sem `correlacao[].ticket_medio` quando nao pode ver; acrescenta `dinheiro_omitido` | authenticated | 14 |
| `ic_anuncios_resumo(p_ini, p_fim, p_vendedores, p_funil, p_agrupar, p_com_dinheiro)` | jsonb de `mkt_anuncios_resumo`, `p_com_dinheiro` forcado a false quando nao pode ver | authenticated | 14 |
| `ic_origem_conversao(p_vendedor, p_data_ini, p_data_fim, p_modo)` | table de `crm_analise_origem_conversao` com `valor_total` nulo quando nao pode ver | authenticated | 14 |
| `ic_card_no_escopo(p_vendedor_id text)` | boolean (regra de escopo do card) | politicas de RLS | 15 |
| `crm_reclassificar_antigos()` | integer (cards movidos) | pg_cron, Admin | 16 |
| `ic_reclassificados_recentes()` | integer (ultimas 24 h) | authenticated | 16 |
| `ic_handoffs_pendentes()` | table (id, cliente_crm_id, nome, telefone, motivo, detalhe, criado_em) | authenticated | 17 |
| `ic_handoff_atender(p_id uuid)` | `ia_handoffs` | authenticated | 17 |
| `ic_ia_contexto(p_cliente uuid, p_limite int = 12)` | jsonb minimo para a IA | SO service_role | 17 |
| `ic_agendamentos_lista(p_de date, p_ate date, p_responsavel text, p_status text)` | table com nome/telefone/etapa/funil do card | authenticated | 18 |
| `ic_agendamento_criar(p_cliente, p_inicio, p_fim, p_responsavel, p_titulo, p_tipo, p_obs)` | `agendamentos` | authenticated | 18 |
| `ic_agendamento_status(p_id uuid, p_status text)` | `agendamentos` | authenticated | 18 |
| `ic_minha_agenda_google()` | table (google_email, ativo, calendar_id, atualizado_em) | authenticated | 18 |
| `ic_funil_resumo(p_funil uuid)` | jsonb (nome, cards, numeros_whatsapp, ultimo_ativo, destinos[]). So Admin (erro 42501 para os demais) | authenticated | 21 |
| `ic_funil_excluir(p_funil uuid, p_destino uuid = null)` | jsonb (ok, funil, cards_movidos, destino, numeros_whatsapp_repontados). So Admin. Com cards ou numeros vinculados exige `p_destino`; move tudo e exclui logicamente numa transacao; bloqueia o ultimo funil ativo e conflito de telefone no destino | authenticated | 21 |

### Dados
Funis (13): `Atendimento Geral`, `Cirurgia Bariátrica`, `Assessoria em
Emagrecimento`. Em todos, `cliente_novo` e a primeira etapa, `cliente_antigo`
a penultima e `fechado` a ultima (as tres chaves que o sistema reconhece). O
gatilho de agendamento (18) move o card para `agendamento_pendente` ou
`consulta_agendada` quando o funil tem uma dessas etapas.

Perfis (13): `Admin` (Administrador), `Vendedor` (Atendente), `SDR`
(Recepção), `Financeiro`. Nome tecnico e o que o front compara; `rotulo` e o
que a clinica ve.

## Regras de acesso (15)

- `anon` nao le nada. Excecao: `insert` em `audit_log` (login falho grava antes
  de autenticar).
- `authenticated` le o que a tela precisa. `clientes_crm`: Admin, Financeiro e
  SDR veem tudo; Vendedor ve `vendedor_id` igual ao seu, nulo, ou em
  `vendedores_responsaveis_ids`. Conversas, historico, jornada, acoes,
  agendamentos, consentimentos e handoffs herdam pelo card.
- Escrita administrativa (perfis, permissoes, telas, funis, etapas, numeros de
  WhatsApp, metas, config da IA, flags, usuarios) so `ic_eh_admin()`.
  `users`: cada um atualiza a propria linha (o front, no Meu Perfil, so envia
  `name` e `photo_base64`; RLS nao restringe colunas).
- `delete` negado em cards, historico, conversas, jornada, agendamentos. O
  front apagava `crm_historico` ao excluir o card; agora o delete
  afeta 0 linhas sem erro e o historico fica.
- `vendedores_whatsapp` (tem `zapi_token`), `audit_log`, logs de entrada e de
  mescla, `ia_decisoes_log`: select so Admin (`audit_log_critico` tambem
  Financeiro). `ic_google_credenciais`: ninguem alem de `service_role`.
- As 4 views do 07 passaram a `security_invoker = on`: a RLS da tabela vale
  por elas tambem.
- `service_role` (webhook, Edge Functions, jobs) tem BYPASSRLS no Supabase.

**Por que as funcoes do nucleo continuam funcionando:** elas nao sao `security
definer`, rodam como quem chama. Toda tabela que elas leem continua legivel
para `authenticated` (com escopo onde ha escopo). Dois desvios conscientes do
plano original, pelo mesmo motivo: `crm_numeros_internos` e
`crm_conversa_analise` ficaram legiveis para logados (o nucleo as le dentro de
`crm_acoes_dia` via `crm_numero_da_casa`; sem leitura, numeros da casa
apareceriam como leads para quem nao e Admin).

## Limitacoes documentadas

1. **`clientes_crm.valor` e `valor_pago` continuam legiveis por `select *`.**
   A RLS do Postgres e por linha, nao por coluna. O front esconde esses campos
   lendo `ic_pode_ver_dinheiro()` do banco (a mesma flag que as RPCs usam),
   mas um usuario logado que chame a API REST direto ve as colunas. Para
   fechar isso de verdade: view com `security_invoker` sem essas colunas, ou
   `column privileges` (`revoke select (valor, valor_pago) ... from
   authenticated`), o que exige trocar o `select *` do front. Decidir na
   homologacao.
2. **Feche a RLS em homologacao antes de producao.** O 15 muda quem ve o que.
   Teste cada perfil (Admin, Atendente, Recepcao, Financeiro) em cada tela
   antes de rodar em producao. O rollback do 15 e rodar o 09 de novo depois de
   derrubar as politicas `ic_*`.
3. **PGlite nao prova pg_cron, pg_net nem realtime.** O job do 16 so agenda se
   `pg_cron` existir; confira em `cron.job` depois de rodar no Supabase.
4. **`ic_pode_ver_dinheiro()` depende do e-mail do JWT** casar com
   `users.email` (case-insensitive). Usuario sem linha em `users` nao ve
   dinheiro nem card nenhum.
5. **`insert` com `returning` exige SELECT.** Quem so tem politica de
   insert (anon em `audit_log`, logados em `leads_distribuicao_log`,
   `audit_log_critico`) grava, mas nao pode encadear `.select()` no
   `.insert()` do supabase-js (`return=representation` falha com "violates
   row-level security"). O `logAudit` do front usa `.insert()` puro
   (`return=minimal`) e passa. Vale para qualquer insert novo nessas tabelas.

## Rollback

Cada arquivo tem o bloco `-- ROLLBACK:` com os comandos. Ordem inversa de
dependencia: 27 -> 26 -> 25 -> 24 -> 23 -> 22 -> 21 -> 18 -> 17 -> 16 -> 15 -> 14 -> 13. O 19 so tem um
`comment on table`. Tabelas de dado (agendamentos, ia_*, ic_jobs_log) sao apagadas pelo
rollback: exporte antes se tiver dado real.

## Teste

`teste/testar-na-base-vazia.mjs` roda 00-24 (pulando o 11) num Postgres 17
local (PGlite), simula `auth.jwt()`, e faz tres rodadas: Admin (nucleo inteiro +
funcoes ic_*), Vendedor sem `ve_dinheiro` (dinheiro omitido) e `set role
authenticated`/`anon` (RLS de verdade: escopo do card, tabelas so-admin,
update da propria linha, anon sem leitura). Veja o cabecalho do arquivo para
rodar.
