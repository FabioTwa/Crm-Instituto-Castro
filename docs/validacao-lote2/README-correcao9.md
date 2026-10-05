# Correção 9: recarregar a página mantém a tela atual

Commit: `fix(nav): roteador por hash e restauração da tela após recarregar`

## Causa raiz

O menu lateral trocava a tela sem tocar na URL. Depois de abrir um card, a hash `#/card/<id>` ficava na barra
mesmo estando em Leads, Pipeline ou qualquer outra tela. No F5, o trecho "link direto" que escrevi na correção 3
lia essa hash, gravava `ic_last_view = view-crm-detalhe` e `ic_crm_detalhe_id = <id>` em `localStorage`, e o
`checkSession` reabria o card. Havia ainda uma segunda fonte da verdade: `showView`
gravava a última tela e `openCRMDetalhe` gravava o último card, ambos em `localStorage`, e o boot os lia. As duas
discordavam da URL.

Prova antes da correção (código antigo, via stash): estando em Leads, a URL continuava
`#/card/...0008`, `ic_last_view` valia `view-leads` e `ic_crm_detalhe_id` guardava o card; o F5 abriu o card.

Resposta às quatro perguntas da investigação:

1. A hash do card **continuava** depois de sair do card pelo menu. Só "Voltar ao Pipeline" a mudava.
2. **Havia** storage do último card (`ic_crm_detalhe_id`) e da última tela (`ic_last_view`), lidos no boot.
3. O `checkSession` (e o login, nos dois ramos) decidia a tela por esse storage. Além disso o login chamava
   `showView('view-dashboard')`, tela que não existe neste produto.
4. O menu **só trocava a tela visualmente**; a URL não acompanhava.

## O que foi feito

Roteador por hash em `ic-extensoes.js` (seção 9b), sem biblioteca e sem build. A URL é a única fonte da verdade.

| Tela | Rota |
|---|---|
| CRM / Pipeline (padrão) | `#/pipeline?funil=<id>&resp=<id>&temp=&valor=&origem=&periodo=` |
| Leads | `#/leads`, `#/leads/atendimento`, `#/leads/origem`, `#/leads/jornada`, `#/leads/vendas` |
| Ações do Dia | `#/acoes-do-dia` |
| Agendamentos | `#/agendamentos` |
| Card completo | `#/card/<id>` (o antigo `#card=<id>` do Google Agenda é normalizado) |
| Usuários | `#/usuarios` |
| Permissões | `#/permissoes` |
| Redistribuir Leads | `#/redistribuir` |
| Gerenciar Funis | `#/funis` |
| Histórico de Alterações | `#/historico` |
| Meu Perfil | `#/perfil` |

- `showView` passa a atualizar a hash: `pushState` ao trocar de tela, `replaceState` ao mudar funil, filtro ou aba.
- Boot e login chamam `icRotear()`: lê a hash, valida permissão com `podeVisualizar` e abre a tela. Sem rota, vai
  a `#/pipeline`.
- Rota inválida, card inexistente ou sem permissão: redireciona para o Pipeline; card inexistente e falta de
  permissão avisam com toast. A tela antiga de "card não encontrado" deixou de ser usada.
- Voltar e avançar do navegador passam pelo mesmo roteador. Se a tela já está ativa (por exemplo, fechar a gaveta
  com o botão voltar), não recarrega.
- Gaveta do card: não altera a rota e não reabre no reload.
- Card completo: "Voltar ao Pipeline", Esc e o voltar do navegador levam ao Pipeline com o funil e os filtros de
  antes. Recarregar em `#/card/<id>` reabre o mesmo card.
- Login: sem sessão, a hash pedida continua na URL; depois de entrar, volta para ela. Sair da conta limpa a rota,
  o funil e os filtros em memória.
- `ic_last_view` e `ic_crm_detalhe_id` não são mais gravados e são apagados do navegador no primeiro carregamento.
  O estado de rolagem do Kanban (`sessionStorage`, só da aba) continua, porque é rolagem, não "onde estou".
- Responsável vindo da URL é aplicado antes de o filtro existir na tela (`crmAplicarEscopoQuery`), senão o primeiro
  carregamento viria sem o filtro.
- Modo demonstração: os ids de funil agora são fixos (`demo/seed-demo.sql`), porque o banco é recriado a cada
  carga e o funil da URL deixava de existir. Isso só existe na demonstração.

## Validação no navegador

| Verificação | Resultado |
|---|---|
| Entrar pelo menu e dar F5 em Leads (aba Origem), Ações do Dia, Agendamentos, Usuários, Permissões, Redistribuir, Histórico, Meu Perfil e Funis | permanece na mesma tela, hash igual |
| Pipeline: trocar funil e filtrar responsável, F5 | mesmo funil, mesmo responsável, mesmos cards |
| Funil da URL que não existe mais | cai no primeiro funil e a URL se corrige |
| Abrir gaveta do card e F5 | volta ao Pipeline, mesmo funil, gaveta fechada |
| Card completo, "Voltar ao Pipeline", F5 | continua no Pipeline |
| Reproduzir o defeito: card, menu para Leads, F5 | agora fica em Leads (`#/leads`) |
| Voltar e avançar entre Ações do Dia, Agendamentos e Pipeline | cada passo vai à tela e à hash certas |
| F5 em `#/card/<id>` | reabre o mesmo card; Esc volta ao Pipeline |
| Sessão encerrada em `#/leads/origem`, F5, login | mostra o login, depois volta a Leads com a aba Origem aberta |
| Sair da conta | hash limpa; novo login vai ao Pipeline |
| `#/card/<uuid inexistente>`, `#/card/id-inexistente`, `#/rota-invalida` | redirecionam ao Pipeline; os dois primeiros com toast |
| Atendente (Vendedor) abre `#/usuarios` | vai ao Pipeline com "Você não tem permissão para acessar esta tela." |

Print `09a`: card inexistente redirecionando ao Pipeline com o aviso.

## Ressalvas

- Vercel: a hash não vai ao servidor, então não há reescrita a configurar. Não pude testar o deploy real nesta
  sessão; o `vercel.json` não precisou mudar.
- O painel do navegador do Claude tem cerca de 500px e os prints saem estreitos. As provas de rota, permissão e
  recarga foram lidas do DOM e da URL, não só de imagem.
- A tela Leads usa âncoras de rolagem: `#/leads/<aba>` abre e rola até a seção. Recarregar mantém a aba, mas a
  posição exata da rolagem dentro da seção não é guardada.
- Os filtros "Período personalizado" entram na URL (`periodo`, `de`, `ate`); a busca por texto do Pipeline não
  entra, de propósito.
