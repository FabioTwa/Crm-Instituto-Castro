-- 11 Agendamentos (pg_cron + pg_net)
-- Job do varredor (cron.job), com o endereco do projeto como EXEMPLO.
--
-- O varredor: a cada 30 s chama o proprio webhook com {"varredor":true}. O
-- webhook relê os envelopes de crm_entrada_bruta que nao chegaram a
-- 'processada' (teto de 5 tentativas; o que passa disso aparece em
-- vw_crm_entrada_parada). Sem este job, mensagem que falhou depois do 200
-- fica parada para sempre.
-- O pedido vai SEM credencial: o webhook roda com
-- verify_jwt desligado e so aceita o atalho do varredor nesse formato.
--
-- TROQUE <SEU-PROJETO> pelo id do projeto Supabase novo antes de rodar.


create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'entrada-bruta-varredor',
  '30 seconds',
  $$
    select net.http_post(
      url := 'https://<SEU-PROJETO>.supabase.co/functions/v1/ic-meta-webhook',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"varredor":true}'::jsonb,
      timeout_milliseconds := 25000
    );
  $$
);
