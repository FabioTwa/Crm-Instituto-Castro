-- 46 Exemplos de valor da Jully com os valores confirmados pelo Instituto
-- (29 e 30/10/2026): consulta com o cirurgiao R$ 500,00, com um retorno
-- incluido em ate 30 dias e parcelamento no cartao de credito; avaliacao
-- inicial da Assessoria em Emagrecimento R$ 500,00, com parcelamento no cartao.
-- IC17 ("Valor?" antes de tudo) deixa de dizer "confirmados presencialmente"
-- e pergunta o atendimento antes do valor; IC18 volta a valer com o texto do
-- Instituto. Nao apaga nada; IC14 continua desligado.
--
-- Antes de mudar, guarda uma copia em ia_exemplos_conversa_bkp_46 (RLS ligado,
-- sem acesso pela API). Idempotente. ROLLBACK no fim.

create table if not exists public.ia_exemplos_conversa_bkp_46 as
  select id, titulo, resposta_ideal, ativo from public.ia_exemplos_conversa
   where titulo like 'IC17 %' or titulo like 'IC18 %';
alter table public.ia_exemplos_conversa_bkp_46 enable row level security;

update public.ia_exemplos_conversa set resposta_ideal =
'Claro! Para eu informar certinho, qual atendimento você procura: a avaliação para emagrecimento, a consulta com o cirurgião ou outra especialidade?'
 where titulo like 'IC17 %';

update public.ia_exemplos_conversa set ativo = true, resposta_ideal =
'Será um prazer receber você! 😊 A consulta com o cirurgião tem o valor de R$ 500,00, com um retorno incluído em até 30 dias e possibilidade de parcelamento no cartão de crédito.

O médico responsável pelo atendimento é definido pela clínica. Você prefere consulta presencial ou online?'
 where titulo like 'IC18 %';

-- Conferencia: IC17 sem valor e IC18 ativo com R$ 500,00; nenhum outro valor nos exemplos ativos.
select titulo, ativo, resposta_ideal ~ 'R\$ 500,00' as tem_500
  from public.ia_exemplos_conversa where titulo like 'IC17 %' or titulo like 'IC18 %' order by titulo;
select titulo from public.ia_exemplos_conversa
 where ativo and resposta_ideal ~ 'R\$' and resposta_ideal !~ 'R\$ 500,00';

-- ROLLBACK (volta os textos e o ativo de antes):
-- update public.ia_exemplos_conversa e set resposta_ideal = b.resposta_ideal, ativo = b.ativo
--   from public.ia_exemplos_conversa_bkp_46 b where b.id = e.id;
-- Depois de conferir que esta tudo certo, a copia pode ser apagada:
-- drop table public.ia_exemplos_conversa_bkp_46;
