-- 20 Apoio ao front: prévia da última mensagem no card do Kanban
-- IC CRM (Instituto Castro). Arquivo novo, não altera nada dos arquivos 00-12.
--
-- O card do Kanban mostra a última mensagem truncada (Parte 3.3). O PostgREST
-- não faz "última linha por grupo", então o front chama esta RPC com os ids
-- dos cards visíveis (até 400 por vez) e recebe uma linha por card.
-- Roda como invoker: a RLS de crm_conversas (15_ic_rls.sql) vale aqui, então
-- um Vendedor só recebe prévias dos cards que pode ver.

create or replace function public.ic_ultimas_mensagens(p_ids uuid[])
returns table (cliente_crm_id uuid, exibicao text, direcao text, autor text, criada_em timestamptz)
language sql
stable
set search_path = public
as $$
  select distinct on (c.cliente_crm_id)
         c.cliente_crm_id, c.exibicao, c.direcao, c.autor, c.criada_em
    from public.crm_conversas c
   where c.cliente_crm_id = any (coalesce(p_ids, '{}'::uuid[]))
     and c.exibicao is not null
   order by c.cliente_crm_id, c.criada_em desc
$$;

comment on function public.ic_ultimas_mensagens(uuid[]) is
  'IC CRM: última mensagem exibível por card, para a prévia do Kanban. Invoker: respeita a RLS de crm_conversas.';

grant execute on function public.ic_ultimas_mensagens(uuid[]) to authenticated;
revoke execute on function public.ic_ultimas_mensagens(uuid[]) from anon;

-- ROLLBACK:
--   drop function if exists public.ic_ultimas_mensagens(uuid[]);
