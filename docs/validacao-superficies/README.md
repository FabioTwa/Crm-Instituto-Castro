# Correção 1: superfícies opacas em modais, painéis e popovers

## Causa raiz

Arquivo: `ferramentas/aplicar-tema-ic.mjs`, ordem dos passos.

O script escrevia o bloco `:root` com os tokens `--ic-*` **antes** do passo que troca hex por tokens.
Esse passo trocava também o `#FFFFFF` que *define* `--ic-white`, e o resultado gerado era:

```css
--ic-white: var(--ic-white);
```

Uma custom property que aponta para si mesma é inválida em tempo de computação. Todo `background: var(--ic-white)` do
sistema (modal, painel lateral, popover, dropdown, cards) passou a valer *transparente*. Em cards sobre o fundo claro
da página ninguém notava; em tudo que é sobreposto, o conteúdo de trás aparecia.

Não era a hipótese inicial (token com alpha trocado por fundo). Essa também existia, em menor escala, e foi corrigida:

| defeito | efeito |
|---|---|
| `--ic-white` apontando para si mesmo | **todas** as superfícies brancas transparentes (causa dos casos 1, 2 e 3) |
| 21 regras com `--ic-border` / `--ic-border-strong` como `background` (trilhos de progresso, chips, hover, toggle) | fundo ~6% a ~37% opaco |
| crachá repintado por mim com fundo `--ic-danger-soft` em estado de alerta e textos internos brancos herdados | popover translúcido e texto ilegível |
| crachá com `z-index: 9500` acima dos modais (`1000`) | cobria os campos do formulário aberto |
| bolhas claras com etiqueta de metadado branca (a bolha era escura) | etiqueta "EQUIPE/LEAD" invisível |
| overlays em `rgba(0,0,0,.5)`, `rgba(15,15,20,.45)`, `rgba(15,23,42,.45)`, `rgba(0,0,0,.55)` e sombra laranja `rgba(255,107,0,.30)` no painel | overlay fora da paleta, brilho laranja |

## Correção na origem (pipeline reproduzível)

- `aplicar-tema-ic.mjs`: `:root` entra por último entre os passos de cor; novo token `--ic-overlay: rgba(14, 14, 37, 0.45)`;
  todos os overlays (CSS e JS inline) usam esse token; sombras laranja viram teal; token alpha nunca é fundo de superfície
  (`corrigirSuperficies`).
- `tema-ic.css`: bloco "SUPERFÍCIES SOBREPOSTAS" (modal, painel, dropdown, toast, crachá) e correção das bolhas.
- Verificações que **reprovam a execução sem gravar** (`aplicar-tema-ic.mjs`, `--verificar`):
  token que referencia a si mesmo; token `--ic-*` definido por `var()`; fundo com `--ic-border`, `--ic-border-strong` ou
  `--ic-overlay` fora de overlay/divisor (CSS e inline); overlay fora do token; superfícies obrigatórias sem fundo opaco
  (`.modal-card`, `.crm-conv-card`, `.crm-fila`, `.month-picker-dropdown`, `.inad-multi-dropdown`, `.login-card`, `.sidebar`, `.toast`).
  Rodado contra o `index.html` anterior, o verificador acusou 30 problemas, inclusive a autorreferência.
- Modos: `--reparar` (reinstala tokens e tema no `index.html`) e `--verificar`.
- Prova de idempotência: rodar `--reparar` sobre o `index.html` não altera o arquivo.

## Componentes auditados

| componente | seletor | fundo atual | z-index |
|---|---|---|---|
| Overlay do painel do card e da conversa | `.crm-conv-modal` | `--ic-overlay` | 9999 |
| Painel do card (abas Anotações, Atividades, Conversa) e conversa em tela cheia | `.crm-conv-card` | `#FFFFFF` opaco, sombra suave | dentro do overlay |
| Popover do crachá da fila | `#crm-fila-espera` / `.crm-fila` | `#FFFFFF` opaco, borda 2px, raio 10px, sombra suave | 900 |
| Overlay dos modais | `.modal-overlay` | `--ic-overlay` | 1000 |
| Modais (Adicionar Cliente, Confirmação, Novo Usuário, Perfil de acesso, linha do tempo da Jornada, Novo Funil...) | `.modal-card` | `#FFFFFF` opaco, borda 2px, sombra suave | 1 (dentro do overlay) |
| Dropdown de mês | `.month-picker-dropdown` | `#FFFFFF` opaco | 1100 |
| Dropdown multi-seleção (sem uso no IC) | `.inad-multi-dropdown` | `#FFFFFF` opaco | 1100 |
| Toasts | `.toast`, `.toast-*` | cores sólidas dos tokens | 2000 |
| Gaveta do menu no mobile | `.ic-drawer-overlay` + `.sidebar` | `--ic-overlay` + `--ic-bg-ice` | 101 / 103 |
| Prévia de documento | `.doc-preview-overlay` | `--ic-overlay` | 2000 |
| Overlays criados por JS (prompt, prévia e progresso da importação CSV) | `style.cssText` em `index.html` (3 pontos) | `--ic-overlay` | 10000 a 10250 |
| Tooltip de observação criado por JS | `style.cssText` em `index.html` | `--ic-primary` opaco | 99999 |
| Cards, colunas, KPIs, tabelas, login | `.card`, `.crm-col`, `.crm-kpi`, `.login-card` | `#FFFFFF` / `--ic-bg-ice` opacos | — |

Ordem de camadas resultante: cards < crachá (900) < modal (1000) < dropdown (1100) < toast (2000) < painel lateral (9999) < overlays JS (10000+).

Fundos definidos por JS (`style.background`/`cssText`): nenhum ponto de superfície usava token alpha; os 3 overlays acima passaram a usar `--ic-overlay`
pela pipeline (sem editar a lógica dos componentes).

## Validação

Em navegador, com seed do modo demonstração local, desktop e 380px. Para cada superfície foi medido o alpha do fundo
(sempre 1) e, em 12 pontos da área, se o elemento do topo pertence à superfície (nenhum ponto vazando). Prints nesta pasta:
`01` a `12` desktop, `13` a `15` em 380px.

## Pendências observadas fora do escopo (só CSS/tema)

- `executarRedistribuicao` usa `confirm()` nativo do navegador e não o modal de confirmação do sistema (Parte 3.2). São 13 usos de
  `confirm()` nativo no `index.html`; trocar por `icConfirmar` é mudança de JS.
- O cabeçalho "VENDEDOR" da tabela de carga em Redistribuir Leads ainda não foi para "Atendente".
- Barras de carga em Redistribuir usam `--ic-danger` (vermelho) e leem como alerta; avaliar `--ic-accent`.
