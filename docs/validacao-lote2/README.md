# Correções de UI e funcionalidade, lote 1 parte 2 (itens 6, 7 e 8)

| item | commit | resumo |
|---|---|---|
| 6 | `cec792c` | anotações e observações aparecem na hora, no painel e no card completo |
| 7 | `fb7ad29` | CPF, telefone, e-mail e origem padronizados (front e banco) |
| 8 | (este) | auditoria geral de campos, validação e feedback |

Migrações novas: `22_ic_historico_realtime.sql`, `23_ic_cadastro_padrao.sql`, `24_ic_limites_de_texto.sql`
(todas com rollback no rodapé). Testes: `node teste/testar-validacao.mjs` (111 verificações das funções puras) e
`teste/testar-na-base-vazia.mjs` (banco, RLS por papel, CPF, origem, limites).

## Item 6, causa raiz

Painel e card completo usavam o **mesmo id** de campo (`crm-anotacao-input`). Com o card já montado,
`getElementById` devolvia o campo escondido, vazio, e o envio saía em silêncio. Além disso o resultado do `insert`
nunca era conferido (RLS bloqueando devolve sucesso com 0 linhas) e salvar observações não redesenhava nada.
Agora existe uma carga e um normalizador do histórico, dois renderizadores que consomem o mesmo array e uma função
que redesenha todo lugar montado (`icAtualizarHistorico`). Provado no navegador: anotação por Enter, vazio
rejeitado, erro com texto preservado, 0 linhas tratado como erro, mesma anotação nos dois lugares, evento
"Observações atualizadas", Ctrl+Enter salva e Enter só quebra linha. Prints `06a`, `06b`.

## Item 7

- **CPF:** máscara ao digitar e ao colar, 11 dígitos gravados, dígitos verificadores, sequências repetidas
  rejeitadas, erro inline "CPF inválido" em `--ic-danger`, banco rejeita igual (`ic_cpf_valido` + constraint).
  Nenhum log recebe o CPF (`icCpfMascararParaLog` existe para quem precisar).
- **Telefone:** exibido `(11) 98456-7712` em card, painel e dados cadastrais (fixo de 8 dígitos e DDI 55 tratados).
  Armazenamento continua E.164 sem `+`. Prova: o cadastro manual de `(11) 98456-7712` bateu na trava de duplicidade
  contra o card existente `5511984567712`.
- **E-mail:** validado, minúsculo, aparado, vazio vira nulo.
- **Origem:** `<select>` com a lista oficial (WhatsApp, Indicação, Lista/Prospecção, Planilha, Importação, Evento,
  Visita, Manual, Anúncio), chave estável no banco (`whatsapp`, `indicacao`, `lista_prospeccao`, `planilha`,
  `importacao`, `evento`, `visita`, `manual`, `anuncio`). O filtro do Kanban usa a mesma lista com `eq`.
  As regex das análises existentes continuam casando com todas as chaves.
- **Migração 23:** copia `cpf/email/origem` dos clientes que vão mudar para `ic_bkp23_cadastro`, grava o que não
  converteu em `ic_cadastro_pendencias` (campo, valor original, motivo) e só então cria triggers e constraints.
  CPF ou e-mail inválido legado vira NULL; origem desconhecida vira `manual`. Tudo recuperável pela cópia.
  `select * from ic_cadastro_pendencias order by campo, criado_em;` lista o que o time precisa conferir.
  Mapeamento: whats/wpp/zap, indica*, lista/prospec*, planilha, importa*/csv, evento, visita, manual,
  anuncio/ads/meta/instagram/facebook/google/site/formul. O webhook grava `Google Ads`; o gatilho converte para
  `anuncio` (o `google_campanha_id` continua separado).
- Prints `07a` (CPF inválido no card), `07b` (CPF inválido ao adicionar cliente), `07c` (Origem como lista e
  telefone formatado).

## Item 8: tabela de auditoria

Legenda de status antes: **ok** já estava correto, **parcial** funcionava com falha, **falha** quebrado.

| tela | campo | status antes | problema | correção |
|---|---|---|---|---|
| Login | e-mail, senha | parcial | sem limite de tamanho | `maxlength` 254/128 (foco); Enter envia pelo `<form>`; limite de tentativas já existia |
| Adicionar Cliente | nome | parcial | sem limite; só `trim` | 200 caracteres no front e `ic_clientes_nome_tam` no banco |
| Adicionar Cliente | telefone | parcial | gravava como digitado | máscara, validação BR existente mantida, grava E.164 sem `+` |
| Adicionar Cliente | e-mail | falha | sem validação nem minúsculo | `icEmailNormalizar`, erro inline, CHECK no banco |
| Adicionar Cliente | CPF | falha | texto livre, sem validação | máscara, dígitos verificadores, erro inline, gatilho e CHECK |
| Adicionar Cliente | origem | parcial | texto do rótulo gravado, sem Anúncio | chave estável, lista oficial completa |
| Adicionar Cliente | data de entrada | **falha** | dia em UTC: depois das 21h em SP gravava o dia seguinte nos leads do dia | `icIsoNoDiaSP` / `icDiaSP` (dia de São Paulo) |
| Adicionar Cliente | observações, profissão | parcial | sem limite | 2000/100 no front, 5000/100 no banco |
| Importação CSV | cpf, e-mail, telefone, origem | falha | linha com CPF/e-mail inválido derrubava o lote; origem livre | mesmas regras do cadastro; campo inválido fica em branco e é contado no resultado; origem desconhecida entra como Importação |
| Painel do card | origem | falha | texto livre; id duplicado com o card | `<select>`, OK confere 1 linha, restaura valor em erro |
| Painel do card | anotação | falha | não adicionava (item 6) | resolvido no item 6 |
| Painel do card | contato | parcial | telefone cru `5511984567712` | formatado |
| Card completo | nome do lead | **falha** | `UPDATE` sem conferir linhas; em erro a tela ficava com nome que o banco não tinha; vazio não voltava | `salvarNomeLead` novo: trim, 200, 0 linhas = erro, restaura, Enter confirma e Esc desfaz |
| Card completo | e-mail, CPF, profissão, origem (botões OK) | falha | toast "Campo atualizado" mesmo com 0 linhas; sem validar | `icSalvarCampoCadastro`: valida, `.select()`, restaura valor anterior, toast real, Enter/Esc |
| Card completo | observações | falha | timeline não atualizava (item 6) | resolvido no item 6, 5000 caracteres |
| Card completo | data de entrada | **falha** | `substring` do ISO dava o dia em UTC e o `toISOString` do navegador deslocava | dia de São Paulo; futura bloqueada; em erro volta o valor; 0 linhas = erro |
| Card completo | anotação (timeline) | falha | item 6 | resolvido |
| Card completo | mensagem da conversa | ok | envio desligado até a integração | sem mudança |
| Ações do Dia | filtro de atendente | ok | só leitura | sem mudança |
| Agendamentos | data, hora, duração, tipo, responsável, observações | parcial | sem proteção a clique duplo | `icSalvarAgendamento` protegido; observações já tinham 500 caracteres; erro de RLS já tratado no banco (`sem acesso a este card`) |
| Usuários | filtros e selects de perfil/atendente | ok | mantêm o tratamento existente | sem mudança |
| Novo Usuário | nome, e-mail, senha, perfil, atendente | ok | já usava `sanitizeInput`, e-mail minúsculo, senha forte, trava de clique | limites de tamanho (foco) |
| Permissões / Perfis de acesso | nome, descrição, cor, switches | parcial | `UPDATE` do perfil sem conferir linhas | `.select('id')`, 0 linhas = erro; clique duplo protegido; 60/300 caracteres |
| Meu Perfil | nome | **falha** | `UPDATE` de `users` sem conferir linhas (toast de sucesso com RLS bloqueando) | `salvarPerfil` novo: trim, 200, 0 linhas = erro |
| Meu Perfil | nova senha | ok | validação de 6 caracteres e toast real | clique duplo protegido |
| Redistribuir | de, para, quantidade, funil | **falha** | toast "N leads transferidos" contava o que tentou, não o que mudou; log ignorava erro; quantidade sem teto | conta só linhas alteradas, 0 = erro, erro do log vira aviso, máximo 5000 |
| Gerenciar Funis | nome, ativo, etapas, permissões | **falha** | 0 linhas no funil virava sucesso; erro do `delete` das etapas ignorado | `.select('id')`, erro do delete para o fluxo; snapshot restaura etapas se o insert falhar |
| Novo Funil (Pipelines) | nome, etapas, cores | parcial | sem proteção a clique duplo (criava dois funis) | protegido; 100/60 caracteres |
| Editar Funil (Pipelines) | nome, etapas | **falha** | em erro nas etapas mostrava o erro e em seguida "Funil atualizado!" com as etapas já apagadas | restaura as etapas antigas e não anuncia sucesso |
| Excluir Funil | confirmação | ok | item 4 do lote 1 | sem mudança |
| Filtros e buscas (Kanban, Leads, Jornada, Auditoria) | selects, busca, datas, mês | ok | só leitura | busca com 100 caracteres; filtro de origem usa a lista oficial |
| Kanban | crachá do card (nome) | **falha (XSS)** | `data-nome` recebia o nome do lead sem escape; o nome vem do WhatsApp, então `x" onmouseover="..."` injetava atributo | `escaparAtributo` aplicado |
| Todas | modais | parcial | Esc e Enter não padronizados | Esc fecha o modal do topo; Enter num campo de modal sem `<form>` aciona o botão principal |

### Campos em R$

Não existe nenhum campo editável em R$ nesta versão: os valores aparecem só como leitura ("Falta R$ ...",
totais) e já obedecem ao interruptor "Ver valores financeiros". `icMoedaMascara`, `icMoedaFormatar` e
`icMoedaParaNumero` estão prontas e testadas (`R$ 1.234,56` na tela, número no banco) para quando o campo existir.

### Segurança, pontos de XSS procurados

`ferramentas/auditar-xss.mjs` varre os quatro arquivos de código atrás de HTML montado por concatenação com campos
de texto livre sem escape. Resultado: **um achado real** (`data-nome`, corrigido) e quinze linhas que são constantes
de código (cores, rótulos de permissão, colunas), números ou mensagens fixas. Mensagens de erro vindas do banco já
passavam por `escapeHtml`. `icConfirmar` e os toasts usam `textContent`. A heurística aponta onde olhar, não prova
ausência de falha.

### Datas

Regra única: dia civil de `America/Sao_Paulo`. Dia puro (`yyyy-mm-dd`) nunca passa por `Date`; instante vira dia com
`icDiaSP`; gravação de um dia escolhido usa `icIsoNoDiaSP` (hora de SP, deslocamento `-03:00`). Teste do caso que
quebrava: 22h30 de SP no dia 5 é 01h30 UTC do dia 6, e `toISOString().slice(0,10)` devolve dia 6.

## Limites e ressalvas honestas

- A auditoria de código cobriu todos os campos listados por leitura do fonte e busca automática; o comportamento
  foi **executado no navegador** para: anotações, observações, CPF, e-mail, origem, nome do lead, data de entrada
  (inclusive futura), `data-nome` malicioso, Esc/Enter em modais, 12 telas sem erro de console. Redistribuição,
  perfis de acesso e edição de funil foram corrigidos por leitura e não foram exercitados com bloqueio de RLS no
  navegador (o demo roda como Admin). A suíte do banco cobre as constraints e as RPCs.
- A edição de funil não é uma transação única (apaga e reinsere etapas). A restauração por snapshot cobre falha na
  inserção, não queda de conexão no meio.
- `24_ic_limites_de_texto.sql` usa `NOT VALID`: vale para linhas novas e alteradas; confira o legado antes de
  `VALIDATE CONSTRAINT`.
- O modo demonstração recria o banco a cada carga; a prova de "sobrevive ao reload" do item 6 foi feita relendo o
  banco, não recarregando a página.
- O painel do navegador do Claude tem cerca de 600px: os prints são do layout estreito.
