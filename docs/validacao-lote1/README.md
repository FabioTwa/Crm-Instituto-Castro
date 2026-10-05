# Correções de UI e funcionalidade, lote 1

Um commit por item. O item 1 (superfícies opacas) foi entregue antes, em `f15e162`, com a validação em
`docs/validacao-superficies/`. Aqui estão os itens 2 a 5 e a regressão final.

| item | commit | resumo |
|---|---|---|
| 1 | `f15e162` | superfícies opacas (já entregue) |
| 2 | `ea0946d` | escala de z-index, modais acima do painel, diálogos nativos trocados, acentuação |
| 3 | `cf00ff7` | rota e tela de card completo |
| 4 | `72f34a6` | exclusão de funil: RPC transacional, soft delete, só Admin |
| 5 | (este) | gutter do conteúdo e rodapé da sidebar |

## Causa raiz de cada item

**2. Modal de confirmação abria atrás do painel.** O painel lateral tinha `z-index: 9999` e o modal `1000`; o resto
eram valores soltos entre 100 e 999999. Não existia escala. Agora são tokens `--z-*` aplicados pela pipeline.
O verificador de `z-index` que escrevi primeiro **passava em falso**: as barras invertidas dos dois regex foram
cortadas na escrita (`z-indexs*:s*(d+)`), então não mapeava nem verificava nada. Quem pegou foi o teste no
navegador (`z-index` do painel continuava 9999). Corrigido e provado com caso negativo.

**3. "Abrir card completo" voltava ao Kanban.** `icAbrirCardDaConversa` fecha o painel e depois chama
`closeModal('modal-lista-vendas')`, um modal da camada de vendas, que não faz parte desta versão. `getElementById` devolvia
`null`, o `.classList` lançava `TypeError` e `openCRMDetalhe` nunca rodava. A tela já existia; o defeito era o
handler. `openModal`/`closeModal` agora toleram modal ausente.

**4. Excluir funil não excluía.** Quatro causas somadas: (a) `crm_funis.delete()` direto devolve sucesso com 0
linhas quando a RLS bloqueia, e a tela tratava como sucesso; (b) o botão do modal chamava
`excluirPipeline(id);loadGerenciarFunis()` sem esperar, então a lista recarregava antes de qualquer exclusão;
(c) não existe chave estrangeira de `clientes_crm.funil_id`, então apagar o funil deixaria cards órfãos e
invisíveis; (d) `vendedores_whatsapp.funil_id` faria o webhook continuar criando cards no funil excluído. A
exclusão física ainda apagava etapas (CASCADE) e histórico.

**5. Conteúdo colado na sidebar e último item do menu "cortado".** Dois defeitos meus do tema: a sidebar ficou com
270px mas o `.main-content` manteve `margin-left: 240px` antigo (conteúdo 30px por baixo da sidebar); e a barra de
rolagem do menu era branca a 15%, invisível no fundo claro, então com o menu cheio numa janela baixa ninguém
percebia que dava para rolar. Achado extra no caminho: `.main-content` é item flex sem `min-width: 0`, e crescia até a
largura do conteúdo, fazendo a página inteira rolar na horizontal (Kanban, Leads, Usuários) em vez de só o quadro.

## O que foi feito

- **Camadas:** `--z-sidebar 100`, `--z-dropdown 200`, `--z-drawer 300`, `--z-modal-overlay 400`, `--z-modal 410`,
  `--z-popover 500`, `--z-toast 600` (+ `--z-boot 700`). Todo `z-index` global do CSS e do JS inline foi mapeado;
  valores locais (até 10) ficam. Modais estáticos sobem para o `<body>`. O verificador reprova `z-index` global solto.
- **Diálogos:** `confirm()`, `prompt()` e `alert()` nativos foram trocados pelo modal do sistema em 12 funções, mais o `alert()` do resultado da importação (Marcar
  Perda, excluir cliente, resgatar, reentrada, remover etapa x2, ativar/desativar usuário, excluir perfil, marcar telas,
  redistribuir, importar backup). `icConfirmar` agora usa `textContent`: nome de lead vem do WhatsApp e nunca vira HTML.
- **Acentuação:** `ferramentas/corrigir-acentos.mjs` (dev, requer acorn) corrige texto visível e preserva chaves,
  nomes de coluna e argumentos. Na primeira versão ele alterou identificadores (`from('permissões')`, `AÇÕES.forEach`,
  `jornadaFiltrar('período')`): foi pego na revisão do diff, restaurado do backup e corrigido (lookahead sem consumir
  o `<script>`, regex Unicode, aspas). 35 trechos finais, nenhum identificador.
- **Card completo:** rota `#/card/<id>`; recarregar e link direto reabrem; `#card=<id>` (Google Agenda) é normalizado;
  voltar do navegador devolve o Kanban no mesmo funil e na mesma rolagem; "Card não encontrado" com botão de voltar;
  principal (negociação, observações, timeline, `detalhe_principal`) e lateral (conversa com tela cheia,
  `detalhe_lateral`, dados cadastrais), empilhadas até 1024px. O dropdown de etapa do card continua **sem** tocar em
  negociações (verificado). Corrida resolvida: fechar a gaveta fazia `history.back()` e abrir o card fazia `pushState`;
  o "voltar" caía numa entrada fantasma e reabria o Kanban. A gaveta agora substitui a própria entrada.
- **Funis:** `21_ic_funis.sql` (`ic_funil_resumo`, `ic_funil_excluir`). Só Admin (42501 para os demais). Com cards
  ou números de WhatsApp exige destino e move tudo numa transação; bloqueia o último funil ativo e conflito de telefone;
  exclusão lógica; linha do tempo por card; auditoria `SOFT_DELETE` com destino e quantidade.
- **Layout:** `--ic-sidebar-w` (270px, um token para os dois lados), `--ic-content-gutter` 32px (≥1024), 24px
  (≤1023), 16px (≤767); `.main-content { min-width: 0 }`; menu com rolagem visível e rodapé fixo. O verificador reprova
  se o `.main-content` deixar de usar os tokens.

## Validação

| verificação | resultado |
|---|---|
| verificador do tema | sem problemas; reprova os casos negativos (autorreferência, alpha, `z-index` solto, layout) |
| suíte do banco (RLS por papel, incluindo a nova RPC) | 193 verificações, 0 falhas |
| 10 telas + fluxo painel → card completo → voltar | sem erro de console |
| gutter, 32/24/16px, em Kanban, Leads, Ações, Usuários, Permissões, Funis... | medido: exatamente o token em todas as telas |
| página com rolagem horizontal no tablet | antes: Kanban, Leads, Usuários; depois: nenhuma (rola dentro do quadro) |

Números do item 5 (1366px): sidebar termina em x=270; o conteúdo começa em x=270; primeira coluna do Kanban em
x=302 (32px). Menu com 9 itens numa janela de 560px: `scrollHeight 523` contra `clientHeight 386`; rolado até o
fim, o último item fica a 24px do rodapé fixo. No mobile, os 9 itens cabem na gaveta, sem rolagem.

## Evidências

`02a` confirmação de ganho sobre o painel · `02b` Marcar Perda sobre o painel · `03a` card completo (1366px) ·
`03b` card completo (380px) · `04` exclusão de funil com cards · `05a` Pipeline com gutter (1366px) · `05b` Leads
(380px) · `05c` menu mobile completo · `05d` sidebar numa janela baixa, menu rolado.

Ressalvas honestas: o painel do navegador do Claude tem ~475px e a captura emulada de 1366px sai reduzida; por isso o
desktop largo está provado principalmente pelos números medidos. As capturas dentro de lotes saem defasadas; só foram
usadas as confirmadas pelo auditor de camadas. O banco do modo demonstração é recriado a cada carga, então o teste
de reload com o mesmo funil usa a rolagem e o funil da sessão.

## Desvio consciente da especificação

O crachá da fila ("11 aguardando resposta") usa `--z-dropdown`, não `--z-popover`. Ele é um selo fixo no canto, não um
popover aberto por clique. Com `--z-popover` (500) ele ficaria acima dos modais (410), que é exatamente o defeito do
item 1 (cobria os campos do formulário aberto). `--z-popover` ficou para tooltips.

## Pendências

- Em `index.html` ainda existe a função morta `_openModalNovoPipeline_old`, que usa `prompt()`. Não é chamada por
  nenhuma tela; pode ser removida numa limpeza.
- Recarregar o card (F5) no modo demonstração mantém o funil pela sessão, mas a rolagem só é restaurada no caminho
  "abrir card -> voltar" dentro da mesma carga da página.
