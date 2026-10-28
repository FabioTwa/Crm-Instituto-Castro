-- 40 Jully, so texto (decisao do Fabio, 28/10/2026).
--
-- O nome da atendente se escreve "Jully". As respostas da IA nao usam emoji:
-- a funcao ja tira emoji de tudo que envia; aqui os exemplos de conversa
-- deixam de ensinar emoji e passam a falar como a Jully.
-- Seguro rodar mais de uma vez.

begin;

update public.crm_ia_config set valor = 'Jully' where chave = 'persona_nome';

update public.ia_exemplos_conversa
set resposta_ideal = regexp_replace(
      regexp_replace(
        regexp_replace(replace(resposta_ideal, 'Julie', 'Jully'),
          '[\U0001F300-\U0001FAFF☀-➿️]', '', 'g'),
        '[ \t]{2,}', ' ', 'g'),
      '[ \t]+([.,!?])', '\1', 'g'),
    contexto = replace(contexto, 'Julie', 'Jully')
where resposta_ideal ~ 'Julie|[\U0001F300-\U0001FAFF☀-➿]'
   or contexto ~ 'Julie';

commit;
