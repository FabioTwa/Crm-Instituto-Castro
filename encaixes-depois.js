// Encaixes de rotas: carregado DEPOIS do script principal e antes do
// DOMContentLoaded (o boot roda no DOMContentLoaded).
//
// O login e o recarregar da pagina mandam para 'view-dashboard', que nao existe
// neste produto. showView ja tem um mapa de rotas antigas (IC_ROTAS_ANTIGAS);
// aqui ele ganha as telas que nao existem no CRM, todas apontando para o pipeline.
(function () {
    var paraOPipeline = [
        'view-dashboard', 'view-painel-central', 'view-minhas-vendas', 'view-nova-venda',
        'view-venda-detalhe', 'view-dados-preenchidos', 'view-dp-detalhe', 'view-comissao',
        'view-meu-score', 'view-trilha', 'view-clientes-carteira', 'view-conciliacao',
        'view-turmas', 'view-turmas-ativas', 'view-lixeira', 'view-vendas-excluidas',
        'view-chat-ia', 'view-precos', 'view-previsao-receita', 'view-lista'
    ];
    paraOPipeline.forEach(function (v) { IC_ROTAS_ANTIGAS[v] = { view: 'view-crm' }; });
})();

// Interruptor de dinheiro. Todo valor em R$ que sobrou dentro das telas do
// CRM (ticket no Atendimento, valor e custo na Origem, valor no painel do
// lead) passa por icPodeVerDinheiro(), que libera Admin e Financeiro.
// Descomente para que ninguem veja R$ nas telas do CRM:
// icPodeVerDinheiro = function () { return false; };
