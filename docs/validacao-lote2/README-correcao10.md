# Correção 10: toolbar de filtros do Pipeline alinhada e textos de outro contexto de negócio

Commit: `fix(pipeline): toolbar de filtros alinhada e textos de outro contexto de negócio`

## Causa raiz

1. **Texto cortado nos selects.** Os selects tinham `height: 40px` fixo em `.crm-toolbar-select` com `padding: 10px 16px`. O tema
   trocou a borda para 2px e a fonte para 14px Manrope. A área de conteúdo ficou com 40 - 20 - 4 = 16px, menor que a
   linha de texto (cerca de 19px), e o navegador cortou o texto em cima e embaixo. Com borda de 1,5px e fonte de
   13px cabia por pouco.
2. **Busca na segunda linha, desalinhada.** Cada campo era uma coluna "rótulo + controle" e a linha usava
   `align-items: flex-end`. Só a Busca tinha rótulo visível; os botões usavam um rótulo invisível de 14px para
   reservar espaço. Os campos de data e de horas reservavam largura mesmo escondidos (`visibility: hidden`), então a
   soma passava da largura e a Busca descia para outra linha.
3. **Placeholder "Buscar empresa, nome ou t…".** Texto de outro contexto de negócio, criado em JS depois de 250ms, sem `aria-label`.
4. **Duas barras.** "Adicionar Cliente" ficava no cabeçalho, longe dos filtros.

O bloco já seguia o gutter da correção 5 (a borda esquerda da toolbar e a da primeira coluna medem a mesma
posição: 302px a 1440px), então o "fora do grid" vinha das quebras de linha, não da margem.

## O que foi feito

CSS no tema (`ferramentas/tema-ic.css`, reproduzido no `index.html` pela mesma pipeline; a prova byte a byte do
`<style>`). Uma classe só, `.ic-toolbar`:

- `display: flex; flex-wrap: wrap; align-items: center; gap: 12px`, 20px de margem inferior.
- Campos e botões com 40px de altura, borda `2px solid var(--ic-border)`, raio 10px, padding vertical zero (o texto
  do select se centraliza sozinho) e seta própria alinhada à direita. No celular a altura sobe para 44px (alvo de
  toque que o sistema já exigia) para toda a toolbar, mantendo a régua.
- Rótulos só para leitor de tela (`.ic-tb-label`) e `aria-label` em todos os controles.
- Busca: `flex: 1 1 260px` (mínimo 220px), lupa interna, placeholder "Buscar por nome ou telefone" e botão × quando
  há texto.
- Datas e horas personalizadas usam o atributo `hidden`: só ocupam espaço quando o filtro está ativo.
- Responsivo: quebra em linhas iguais; a 600px a Busca sobe para a primeira linha em largura total; a 420px cada
  filtro ocupa uma linha, sem texto cortado. Sem rolagem horizontal da página em nenhuma largura testada.

Pipeline, ordem da toolbar: funil, busca, atendente, período, espera, "Mais filtros" (e "Limpar tudo" quando há filtro)
e, à direita, "Adicionar Cliente" (`margin-left: auto`). Mesma classe em Leads, Ações do Dia, Agendamentos (as datas
ganharam prefixo "De" e "Até" dentro do campo, porque uma data sem rótulo não se explica), Histórico de Alterações e
nas abas de Usuários.

## Varredura de textos herdados

`ferramentas/auditar-textos.mjs` varre o texto visível (HTML e literais de JS, ignorando classes, ids e colunas) atrás
de empresa, aluno, curso, turma, matrícula, mensalidade, inadimplência, vestibular, franquia e colaborador.
Resultado antes: 3 achados, 1 falso positivo ("em curso", que é "em andamento"). Segunda varredura, de vocabulário
comercial, gerou a lista abaixo. Nada que seja nome técnico, coluna ou chave do banco foi alterado.

| onde | antes | depois |
|---|---|---|
| Busca do Pipeline | Buscar empresa, nome ou telefone... | Buscar por nome ou telefone |
| Novo funil, exemplo | Ex: Vendas B2B, Pós-venda... | Ex: Cirurgia Bariátrica, Pós-operatório... |
| Leads, Atendimento | vendedor não respondeu | atendente não respondeu |
| Leads, Atendimento | Por vendedor | Por atendente |
| Chips de filtro | vendedor especifico | atendente específico |
| Chip do filtro (reserva) | vendedor | atendente |
| Atendentes responsáveis (2 telas) | — Nenhum vendedor — | — Nenhum atendente — |
| Atendentes responsáveis (2 telas) | N vendedores selecionados | N atendentes selecionados |
| Atendentes responsáveis | Nenhum vendedor cadastrado | Nenhum atendente cadastrado |
| Toast | Vendedores atualizados (N) | Atendentes atualizados (N) |
| Leads, origem | Recorte de vários vendedores... | Recorte de vários atendentes... |
| Permissões, escopo | Turmas permitidas (2 telas inexistentes) | removido: as telas Turmas não existem neste produto |
| Histórico de Alterações | Todas operacoes | Todas as operações |
| Histórico de Alterações | Leads (clientes_crm), Funis (crm_funis) | Leads, Funis |
| Agendamentos | filtros "Todos" | Todos os status, Todos os responsáveis |

Mantido de propósito: o perfil de acesso chamado "Vendedor" (é dado do banco, não texto de interface), "Cliente"/"Adicionar
Cliente" (a clínica usa o termo), a seção "Vendas" da tela Leads (já avisa que o módulo é versão futura) e os rótulos
das etapas padrão (`Pagamento Pendente` etc.), que só aparecem se um funil usar essas chaves, o que os funis do
IC não fazem. Trocar "cliente" por "paciente" no produto inteiro mexeria em dezenas de mensagens e foi deixado para
decisão da equipe.

## Validação

Medido no navegador (alturas, alinhamento, corte de texto, rolagem horizontal) e com prints:

| largura | resultado |
|---|---|
| 1440px | funil, busca, atendente, período e espera na primeira linha; "Mais filtros" e "Adicionar Cliente" na segunda, com a borda direita no fim das colunas. Altura 40px em tudo, texto dos selects sem corte, borda esquerda 302px = primeira coluna |
| 1280px | idem, linhas iguais |
| 1024px | três linhas, mesmo espaçamento; × da busca aparece com texto |
| 380px | busca em largura total na primeira linha, depois um filtro por linha, altura 44px em tudo, sem rolagem horizontal da página |

Prints: `10-pipeline-1440`, `10-pipeline-1280`, `10-pipeline-1024-busca-com-x`, `10-pipeline-380`,
`10-leads-1440`, `10-agendamentos-1440`, `10-historico-1440`, `10-acoes-do-dia-1440`.
Usuários foi conferido pela medida (abas de 40px); não tem print próprio.

Também conferido: trocar o período para "Personalizado" mostra as datas e voltar as esconde; "Espera" personalizada
idem; um filtro ativo faz aparecer "Limpar tudo", atualiza o contador de "Mais filtros" e a URL (correção 9); nenhum
erro de console.

## Ressalvas

- **A 1440px não cabem os sete controles numa linha só.** A área útil é de 1091px (sidebar de 270px mais gutter de
  32px) e o mínimo sem cortar texto é cerca de 1219px (funil 162, busca 220, atendente 175, período 158, espera 148,
  "Mais filtros" 127, "Adicionar Cliente" 157, mais 72px de gap). Por isso "Mais filtros" e "Adicionar Cliente"
  descem juntos para uma segunda linha, com o botão primário à direita. Numa janela de cerca de 1530px ou mais tudo
  fica em uma linha. A alternativa seria encurtar as opções padrão dos selects, o que não foi feito sem sua decisão.
- O cabeçalho do Pipeline (título e botões de CSV) continua como era; só "Adicionar Cliente" saiu dele.
- O painel do navegador do Claude tem largura limitada: os prints de 1440px e 1280px são reduções.
