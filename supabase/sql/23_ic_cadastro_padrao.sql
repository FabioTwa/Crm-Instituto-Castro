-- 23 Cadastro padronizado: CPF validado, e-mail normalizado, origem com lista oficial
-- =====================================================================================
-- O front valida e formata, mas o banco é a garantia (importação CSV, API e webhook também gravam aqui).
--
-- O que muda em public.clientes_crm:
--   cpf     -> só 11 dígitos, dígitos verificadores oficiais, sem sequência repetida (ic_cpf_valido)
--   email   -> minúsculo, sem espaços; vazio vira NULL; formato validado
--   origem  -> chave estável da lista oficial (whatsapp, indicacao, lista_prospeccao, planilha,
--              importacao, evento, visita, manual, anuncio)
--   telefone-> NÃO muda: segue em E.164 sem "+" (o webhook casa por esse formato)
--
-- Os arquivos 00-12 não são reescritos: o gatilho trg_crm_origem_normalizar continua; este arquivo só ACRESCENTA
-- um gatilho (trg_ic_cadastro_normalizar) que roda depois dele (ordem alfabética: crm < ic).
-- As análises do esquema base usam regex em origem (lista|prospec|indica|evento|visita|planilha|importa|anuncio...);
-- todas as chaves oficiais continuam casando com elas.
--
-- Dados existentes (nada é apagado sem cópia):
--   1. cópia integral de cpf/email/origem em ic_bkp23_cadastro (uma linha por cliente alterado);
--   2. valores que não puderam ser convertidos vão para ic_cadastro_pendencias (campo, valor original, motivo)
--      e o campo é tratado assim: cpf inválido -> NULL; e-mail inválido -> NULL; origem desconhecida -> 'manual'.
--      O valor original continua na cópia (1) e na lista (2) para o time corrigir à mão.
--   3. só depois as constraints entram.
-- Consulta da lista: select * from ic_cadastro_pendencias order by campo, criado_em;
--
-- ROLLBACK no rodapé (e a cópia permite restaurar os valores originais).

-- ------------------------------------------------------------------ funções
create or replace function public.ic_cpf_valido(p text)
returns boolean
language plpgsql
immutable
as $$
declare
  d text;
  soma int;
  dv int;
  n int;
  i int;
begin
  if p is null then return false; end if;
  d := regexp_replace(p, '\D', '', 'g');
  if length(d) <> 11 then return false; end if;
  if d ~ '^(\d)\1{10}$' then return false; end if;
  for n in 9..10 loop
    soma := 0;
    for i in 1..n loop
      soma := soma + substr(d, i, 1)::int * (n + 2 - i);
    end loop;
    dv := (soma * 10) % 11;
    if dv = 10 then dv := 0; end if;
    if dv <> substr(d, n + 1, 1)::int then return false; end if;
  end loop;
  return true;
end;
$$;

-- Mapeamento explícito (mesma regra de icOrigemChave em ic-validacao.js). Devolve NULL se não reconhecer.
create or replace function public.ic_origem_chave(p text)
returns text
language sql
immutable
as $$
  with n as (
    select regexp_replace(
             translate(lower(btrim(coalesce(p, ''))), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'),
             '[\s\-/]+', '_', 'g') as o
  )
  select case
    when o = '' then null
    when o in ('whatsapp','indicacao','lista_prospeccao','planilha','importacao','evento','visita','manual','anuncio') then o
    when o ~ '^(whats|wpp|zap)' then 'whatsapp'
    when o ~ '^indica' then 'indicacao'
    when o ~ '^(lista|prospec)' then 'lista_prospeccao'
    when o ~ '^planilha' then 'planilha'
    when o ~ '^(importa|csv)' then 'importacao'
    when o ~ '^evento' then 'evento'
    when o ~ '^visita' then 'visita'
    when o ~ '^manual' then 'manual'
    when o ~ '^(anuncio|ads|meta|instagram|facebook|google|site|formul)' then 'anuncio'
    else null
  end from n;
$$;

create or replace function public.ic_email_valido(p text)
returns boolean
language sql
immutable
as $$
  select p is not null
     and length(p) <= 254
     and p = lower(btrim(p))
     and p ~ '^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$'
     and position('..' in p) = 0;
$$;

-- ------------------------------------------------------- cópia e pendências
create table if not exists public.ic_bkp23_cadastro (
  cliente_id uuid primary key,
  cpf text,
  email text,
  origem text,
  copiado_em timestamptz not null default now()
);
create table if not exists public.ic_cadastro_pendencias (
  id bigserial primary key,
  cliente_id uuid not null,
  campo text not null check (campo in ('cpf','email','origem')),
  valor_original text,
  motivo text not null,
  criado_em timestamptz not null default now()
);
-- Contêm dado pessoal (CPF/e-mail): RLS ligada e nenhuma política = só service role / SQL do administrador do banco.
alter table public.ic_bkp23_cadastro enable row level security;
alter table public.ic_cadastro_pendencias enable row level security;

-- Só entra na cópia o cliente que realmente vai mudar; rodar de novo não duplica nem sobrescreve.
insert into public.ic_bkp23_cadastro (cliente_id, cpf, email, origem)
select c.id, c.cpf, c.email, c.origem
from public.clientes_crm c
where (c.cpf is not null and c.cpf !~ '^\d{11}$')
   or (c.cpf is not null and not public.ic_cpf_valido(c.cpf))
   or (c.email is not null and c.email <> lower(btrim(c.email)))
   or (c.email is not null and not public.ic_email_valido(lower(btrim(c.email))))
   or (c.origem is not null and c.origem not in ('whatsapp','indicacao','lista_prospeccao','planilha','importacao','evento','visita','manual','anuncio'))
on conflict (cliente_id) do nothing;

-- ------------------------------------------------------------ normalização
-- CPF: tira pontuação; o que continuar inválido vai para a lista de pendências e fica NULL.
insert into public.ic_cadastro_pendencias (cliente_id, campo, valor_original, motivo)
select c.id, 'cpf', c.cpf, 'CPF inválido (dígitos verificadores, tamanho ou sequência repetida)'
from public.clientes_crm c
where nullif(btrim(c.cpf), '') is not null and not public.ic_cpf_valido(c.cpf);

update public.clientes_crm set cpf = regexp_replace(cpf, '\D', '', 'g')
where cpf is not null and public.ic_cpf_valido(cpf) and cpf !~ '^\d{11}$';
update public.clientes_crm set cpf = null
where cpf is not null and not public.ic_cpf_valido(cpf);

-- E-mail
insert into public.ic_cadastro_pendencias (cliente_id, campo, valor_original, motivo)
select c.id, 'email', c.email, 'E-mail com formato inválido'
from public.clientes_crm c
where nullif(btrim(c.email), '') is not null and not public.ic_email_valido(lower(btrim(c.email)));

update public.clientes_crm set email = null where email is not null and btrim(email) = '';
update public.clientes_crm set email = lower(btrim(email))
where email is not null and public.ic_email_valido(lower(btrim(email))) and email <> lower(btrim(email));
update public.clientes_crm set email = null where email is not null and not public.ic_email_valido(email);

-- Origem: mapeamento explícito; o que não casar vai para a lista e vira 'manual'.
insert into public.ic_cadastro_pendencias (cliente_id, campo, valor_original, motivo)
select c.id, 'origem', c.origem, 'Origem fora da lista oficial; convertida para manual'
from public.clientes_crm c
where nullif(btrim(c.origem), '') is not null and public.ic_origem_chave(c.origem) is null;

update public.clientes_crm set origem = coalesce(public.ic_origem_chave(origem), 'manual')
where nullif(btrim(origem), '') is not null
  and origem not in ('whatsapp','indicacao','lista_prospeccao','planilha','importacao','evento','visita','manual','anuncio');
update public.clientes_crm set origem = null where origem is not null and btrim(origem) = '';

-- --------------------------------------------------------------- gatilho
-- Vale para INSERT/UPDATE vindos de qualquer lugar (front, CSV, webhook, API).
-- CPF inválido e e-mail inválido são REJEITADOS (erro com mensagem clara), não corrigidos em silêncio.
-- Origem desconhecida (ex.: o webhook grava 'Google Ads') é mapeada; sem mapa, vira 'manual'.
create or replace function public.ic_cadastro_normalizar()
returns trigger
language plpgsql
as $$
begin
  if new.cpf is not null then
    new.cpf := nullif(regexp_replace(new.cpf, '\D', '', 'g'), '');
    if new.cpf is not null and not public.ic_cpf_valido(new.cpf) then
      raise exception 'CPF inválido' using errcode = '22023';
    end if;
  end if;
  if new.email is not null then
    new.email := nullif(lower(btrim(new.email)), '');
    if new.email is not null and not public.ic_email_valido(new.email) then
      raise exception 'E-mail inválido' using errcode = '22023';
    end if;
  end if;
  if new.origem is not null then
    if btrim(new.origem) = '' then
      new.origem := null;
    else
      new.origem := coalesce(public.ic_origem_chave(new.origem), 'manual');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ic_cadastro_normalizar on public.clientes_crm;
create trigger trg_ic_cadastro_normalizar
  before insert or update of cpf, email, origem on public.clientes_crm
  for each row execute function public.ic_cadastro_normalizar();

-- ----------------------------------------------------------- constraints
alter table public.clientes_crm drop constraint if exists ic_clientes_cpf_valido;
alter table public.clientes_crm add constraint ic_clientes_cpf_valido
  check (cpf is null or (cpf ~ '^\d{11}$' and public.ic_cpf_valido(cpf)));

alter table public.clientes_crm drop constraint if exists ic_clientes_email_valido;
alter table public.clientes_crm add constraint ic_clientes_email_valido
  check (email is null or public.ic_email_valido(email));

alter table public.clientes_crm drop constraint if exists ic_clientes_origem_oficial;
alter table public.clientes_crm add constraint ic_clientes_origem_oficial
  check (origem is null or origem in ('whatsapp','indicacao','lista_prospeccao','planilha','importacao','evento','visita','manual','anuncio'));

-- ROLLBACK (restaura os valores originais a partir da cópia e remove tudo que este arquivo criou):
-- alter table public.clientes_crm drop constraint if exists ic_clientes_cpf_valido;
-- alter table public.clientes_crm drop constraint if exists ic_clientes_email_valido;
-- alter table public.clientes_crm drop constraint if exists ic_clientes_origem_oficial;
-- drop trigger if exists trg_ic_cadastro_normalizar on public.clientes_crm;
-- update public.clientes_crm c set cpf = b.cpf, email = b.email, origem = b.origem
--   from public.ic_bkp23_cadastro b where b.cliente_id = c.id;
-- drop function if exists public.ic_cadastro_normalizar();
-- drop function if exists public.ic_email_valido(text);
-- drop function if exists public.ic_origem_chave(text);
-- drop function if exists public.ic_cpf_valido(text);
-- (guarde ic_bkp23_cadastro e ic_cadastro_pendencias até o time conferir; depois: drop table ...)
