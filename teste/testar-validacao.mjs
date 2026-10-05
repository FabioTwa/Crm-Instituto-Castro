// Testes das funções puras de cadastro (ic-validacao.js). Sem dependências: node teste/testar-validacao.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const V = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ic-validacao.js'));

let falhas = 0, total = 0;
function igual(nome, obtido, esperado) {
    total++;
    const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
    if (!ok) falhas++;
    console.log((ok ? 'ok     ' : 'FALHOU ') + nome + (ok ? '' : '  obtido=' + JSON.stringify(obtido) + ' esperado=' + JSON.stringify(esperado)));
}

// ---- CPF
igual('cpf válido formatado', V.icCpfValido('529.982.247-25'), true);
igual('cpf válido só dígitos', V.icCpfValido('52998224725'), true);
igual('cpf válido 2', V.icCpfValido('111.444.777-35'), true);
igual('cpf dígito verificador errado', V.icCpfValido('529.982.247-24'), false);
igual('cpf sequência repetida 111...', V.icCpfValido('111.111.111-11'), false);
igual('cpf sequência repetida 000...', V.icCpfValido('00000000000'), false);
igual('cpf curto', V.icCpfValido('1234567890'), false);
igual('cpf longo', V.icCpfValido('529982247250'), false);
igual('cpf letras', V.icCpfValido('abc'), false);
igual('máscara progressiva 3', V.icCpfMascara('529'), '529');
igual('máscara progressiva 4', V.icCpfMascara('5299'), '529.9');
igual('máscara progressiva 7', V.icCpfMascara('5299822'), '529.982.2');
igual('máscara progressiva 10', V.icCpfMascara('5299822472'), '529.982.247-2');
igual('máscara completa', V.icCpfMascara('52998224725'), '529.982.247-25');
igual('máscara corta em 11 dígitos', V.icCpfMascara('529982247259999'), '529.982.247-25');
igual('máscara ignora letras', V.icCpfMascara('5a2b9'), '529');
igual('colar com pontuação', V.icCpfDigitos('529.982.247-25'), '52998224725');
igual('normalizar vazio ok', V.icCpfNormalizar('  '), { ok: true, valor: null, erro: null });
igual('normalizar válido guarda 11 dígitos', V.icCpfNormalizar('529.982.247-25'), { ok: true, valor: '52998224725', erro: null });
igual('normalizar inválido', V.icCpfNormalizar('529.982.247-24'), { ok: false, valor: null, erro: 'CPF inválido' });
igual('formatar exibição', V.icCpfFormatar('52998224725'), '529.982.247-25');
igual('formatar legado sem 11 dígitos volta como veio', V.icCpfFormatar('123'), '123');
igual('log mascarado', V.icCpfMascararParaLog('52998224725'), '***.***.***-25');
igual('log nunca contém o CPF inteiro', V.icCpfMascararParaLog('52998224725').includes('529982'), false);

// ---- Telefone
igual('formatar celular E.164', V.icTelefoneFormatar('5511984567712'), '(11) 98456-7712');
igual('formatar celular sem DDI', V.icTelefoneFormatar('11984567712'), '(11) 98456-7712');
igual('formatar fixo (8 dígitos + DDD)', V.icTelefoneFormatar('1133334444'), '(11) 3333-4444');
igual('formatar fixo com DDI', V.icTelefoneFormatar('551133334444'), '(11) 3333-4444');
igual('formatar já formatado', V.icTelefoneFormatar('(11) 98456-7712'), '(11) 98456-7712');
igual('formatar vazio', V.icTelefoneFormatar(null), '');
igual('formatar número fora do padrão volta como veio', V.icTelefoneFormatar('123456'), '123456');
igual('E.164 de celular formatado', V.icTelefoneParaE164('(11) 98456-7712'), '5511984567712');
igual('E.164 com +55', V.icTelefoneParaE164('+55 11 98456-7712'), '5511984567712');
igual('E.164 já E.164', V.icTelefoneParaE164('5511984567712'), '5511984567712');
igual('E.164 fixo', V.icTelefoneParaE164('(11) 3333-4444'), '551133334444');
igual('E.164 inválido', V.icTelefoneParaE164('12345'), null);
igual('máscara tel 11 dígitos', V.icTelefoneMascara('11984567712'), '(11) 98456-7712');
igual('máscara tel 10 dígitos', V.icTelefoneMascara('1133334444'), '(11) 3333-4444');
igual('máscara tel parcial', V.icTelefoneMascara('119'), '(11) 9');
igual('máscara tel só DDD', V.icTelefoneMascara('11'), '(11');
igual('máscara tel com DDI colado', V.icTelefoneMascara('5511984567712'), '(11) 98456-7712');
igual('erro tel vazio', V.icTelefoneErro(''), 'Telefone é obrigatório.');
igual('erro tel curto', V.icTelefoneErro('12345') !== null, true);
igual('erro tel celular sem 9', V.icTelefoneErro('(11) 88456-7712'), 'Celular deve começar com 9 depois do DDD.');
igual('erro tel ok', V.icTelefoneErro('(11) 98456-7712'), null);
igual('erro tel DDD zero', V.icTelefoneErro('(01) 98456-7712'), 'DDD inválido.');

// ---- E-mail
igual('email normaliza caixa e espaços', V.icEmailNormalizar('  Fulano@Exemplo.COM '), { ok: true, valor: 'fulano@exemplo.com', erro: null });
igual('email vazio ok', V.icEmailNormalizar(''), { ok: true, valor: null, erro: null });
igual('email sem arroba', V.icEmailNormalizar('fulano.com').ok, false);
igual('email sem domínio', V.icEmailNormalizar('fulano@x').ok, false);
igual('email com espaço no meio', V.icEmailNormalizar('ful ano@x.com').ok, false);
igual('email ponto duplo', V.icEmailNormalizar('a..b@x.com').ok, false);
igual('email com + e subdomínio', V.icEmailNormalizar('a+b@mail.x.com.br').valor, 'a+b@mail.x.com.br');

// ---- Origem
igual('origem lista oficial tem 9', V.IC_ORIGENS.length, 9);
igual('origem WhatsApp', V.icOrigemChave('WhatsApp'), 'whatsapp');
igual('origem whatsapp direto', V.icOrigemChave('WhatsApp direto'), 'whatsapp');
igual('origem Indicação', V.icOrigemChave('Indicação'), 'indicacao');
igual('origem indicacao sem acento', V.icOrigemChave('indicacao'), 'indicacao');
igual('origem Lista/Prospecção', V.icOrigemChave('Lista/Prospecção'), 'lista_prospeccao');
igual('origem Planilha', V.icOrigemChave('Planilha'), 'planilha');
igual('origem Importação', V.icOrigemChave('Importação'), 'importacao');
igual('origem Importação manual', V.icOrigemChave('Importação manual'), 'importacao');
igual('origem CSV', V.icOrigemChave('csv'), 'importacao');
igual('origem Evento', V.icOrigemChave('Evento'), 'evento');
igual('origem Visita', V.icOrigemChave('Visita'), 'visita');
igual('origem Manual', V.icOrigemChave('Manual'), 'manual');
igual('origem Anúncio', V.icOrigemChave('Anúncio'), 'anuncio');
igual('origem Google Ads cai em anúncio', V.icOrigemChave('Google Ads'), 'anuncio');
igual('origem Instagram cai em anúncio', V.icOrigemChave('Instagram'), 'anuncio');
igual('origem desconhecida', V.icOrigemChave('Panfleto no ônibus'), null);
igual('origem vazia', V.icOrigemChave('  '), null);
igual('rótulo whatsapp', V.icOrigemRotulo('whatsapp'), 'WhatsApp');
igual('rótulo lista_prospeccao', V.icOrigemRotulo('lista_prospeccao'), 'Lista/Prospecção');
igual('rótulo desconhecido volta como veio', V.icOrigemRotulo('Panfleto'), 'Panfleto');
igual('toda chave oficial é idempotente', V.IC_ORIGENS.every(o => V.icOrigemChave(o.chave) === o.chave), true);
igual('todo rótulo oficial mapeia para a própria chave', V.IC_ORIGENS.every(o => V.icOrigemChave(o.rotulo) === o.chave), true);

// ---- Dinheiro
igual('moeda formatar', V.icMoedaFormatar(1234.56), 'R$ 1.234,56');
igual('moeda formatar zero', V.icMoedaFormatar(0), 'R$ 0,00');
igual('moeda formatar milhão', V.icMoedaFormatar(1234567.5), 'R$ 1.234.567,50');
igual('moeda formatar vazio', V.icMoedaFormatar(null), '');
igual('moeda máscara 1 dígito', V.icMoedaMascara('5'), 'R$ 0,05');
igual('moeda máscara 3 dígitos', V.icMoedaMascara('123'), 'R$ 1,23');
igual('moeda máscara digitando', V.icMoedaMascara('R$ 12,345'), 'R$ 123,45');
igual('moeda máscara vazia', V.icMoedaMascara(''), '');
igual('moeda parse completo', V.icMoedaParaNumero('R$ 1.234,56'), 1234.56);
igual('moeda parse vírgula', V.icMoedaParaNumero('1234,56'), 1234.56);
igual('moeda parse ponto decimal', V.icMoedaParaNumero('1234.56'), 1234.56);
igual('moeda parse milhar sem centavos', V.icMoedaParaNumero('1.234'), 1234);
igual('moeda parse inteiro', V.icMoedaParaNumero('450'), 450);
igual('moeda parse lixo', V.icMoedaParaNumero('abc'), null);
igual('moeda parse vazio', V.icMoedaParaNumero(''), null);
igual('moeda parse negativo', V.icMoedaParaNumero('-R$ 10,00'), -10);
igual('moeda ida e volta', V.icMoedaParaNumero(V.icMoedaFormatar(98765.43)), 98765.43);

// ---- Data
igual('data pura não desloca um dia', V.icDataBR('2026-10-05'), '05/10/2026');
igual('data 1º de janeiro não desloca', V.icDataBR('2026-01-01'), '01/01/2026');
igual('timestamp 00:30 UTC ainda é dia anterior em SP', V.icDataBR('2026-10-05T00:30:00Z'), '04/10/2026');
igual('data BR para ISO', V.icDataParaIso('05/10/2026'), '2026-10-05');
igual('data inexistente 31/02', V.icDataParaIso('31/02/2026'), null);
igual('data bissexta 29/02/2028', V.icDataParaIso('29/02/2028'), '2028-02-29');
igual('data não bissexta 29/02/2027', V.icDataParaIso('29/02/2027'), null);
igual('data mal formada', V.icDataParaIso('2026-10-05'), null);

// ---- Dia em São Paulo (sem deslocar um dia)
igual('dia SP: 22h em SP (01h UTC do dia seguinte) segue no dia certo', V.icDiaSP('2026-10-06T01:00:00Z'), '2026-10-05');
igual('dia SP: toISOString().slice(0,10) erraria no mesmo instante', new Date('2026-10-06T01:00:00Z').toISOString().slice(0, 10), '2026-10-06');
igual('dia SP: 03h UTC ainda é dia anterior', V.icDiaSP('2026-10-05T02:59:00Z'), '2026-10-04');
igual('dia SP: 03h UTC em ponto é o dia', V.icDiaSP('2026-10-05T03:00:00Z'), '2026-10-05');
igual('dia SP: texto yyyy-mm-dd volta igual', V.icDiaSP('2026-10-05'), '2026-10-05');
igual('dia SP: timestamp do Postgres com espaço', V.icDiaSP('2026-10-05 12:00:00+00'), '2026-10-05');
igual('dia SP: vazio', V.icDiaSP(null), '');
igual('iso no dia SP: 22h30 de SP', V.icIsoNoDiaSP('2026-10-05', new Date('2026-10-06T01:30:00Z')), '2026-10-05T22:30:00-03:00');
igual('iso no dia SP: ida e volta preserva o dia', V.icDiaSP(V.icIsoNoDiaSP('2026-10-05', new Date('2026-10-06T01:30:00Z'))), '2026-10-05');
igual('iso no dia SP: gravado em UTC, ainda é o mesmo dia em SP', V.icDiaSP(new Date(V.icIsoNoDiaSP('2026-10-05', new Date('2026-10-06T01:30:00Z'))).toISOString()), '2026-10-05');

console.log('\n' + (total - falhas) + ' de ' + total + ' verificações passaram' + (falhas ? ', ' + falhas + ' FALHARAM' : ''));
process.exit(falhas ? 1 : 0);
