// Encaixes da camada de venda: carregado ANTES do script principal.
//
// O CRM termina quando o card e ganho ou perdido. O que vem depois (venda,
// ficha, contrato, pagamento) e outra camada, fora de escopo nesta fase do
// IC CRM (Parte 4 do pedido). Nos pontos onde a tela mostraria essa
// camada, o código chama um encaixe. Aqui o IC CRM pendura os PLACEHOLDERS
// da Parte 3.4: bloco tracejado, estado vazio elegante, nada de dado de venda.
// A relacao no modelo de dados ja existe (tabela `vendas` reduzida, 03_encaixe_vendas.sql),
// entao a camada futura pluga sem quebrar schema.
//
// Lugares:
//   detalhe_lateral   coluna da esquerda do card completo (indicacoes/comissoes)
//   detalhe_principal fim da coluna principal do card completo (ficha/contrato/pagamento)
//   leadsSecVendas    secao "Vendas" da tela de Leads

window.IC_ENCAIXES = window.IC_ENCAIXES || {};

window.IC_ENCAIXES.detalhe_principal = function (card) {
    return '<div class="ic-placeholder" data-encaixe="detalhe_principal">'
        + '<span class="ic-eyebrow">Área de integração — ficha / contrato / pagamento</span>'
        + '<p>Nenhuma informação de venda ou contrato registrada.</p>'
        + '</div>';
};

window.IC_ENCAIXES.detalhe_lateral = function (card) {
    return '<div class="ic-placeholder pequeno" data-encaixe="detalhe_lateral">'
        + '<span class="ic-eyebrow">Indicações / comissões</span>'
        + '<p>Nenhuma informação registrada nesta versão.</p>'
        + '</div>';
};

function icEncaixeHtml(lugar, card) {
    var fn = window.IC_ENCAIXES[lugar];
    if (typeof fn !== 'function') return '';
    try { return String(fn(card) || ''); }
    catch (e) { console.error('[ic] encaixe ' + lugar + ' falhou:', e); return ''; }
}

// Secao "Vendas" da tela de Leads: estado vazio (Parte 3.7, aba 5). A rota/aba
// existe; a camada nao.
async function leadsSecVendas(corpo, ctx) {
    var fn = window.IC_ENCAIXES.leadsSecVendas;
    if (typeof fn === 'function') return fn(corpo, ctx);
    corpo.innerHTML = '<div class="ic-vazio-grande">'
        + (typeof icon === 'function' ? icon('lock', 36) : '')
        + '<h3>Módulo de Vendas disponível em versão futura</h3>'
        + '<p>Esta aba vai medir conversão da safra, fechamentos e ticket. Os outros números da tela não dependem dela.</p>'
        + '</div>';
}
