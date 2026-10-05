-- 21 Exclusão de funil: validada, transacional, lógica (soft delete) e auditada
-- IC CRM (Instituto Castro). Arquivo novo, não altera nada dos arquivos 00-12 além de ADICIONAR duas colunas
-- e um gatilho de auditoria em crm_funis.
--
-- POR QUE EXISTE
-- A tela chamava crm_funis.delete() direto, e isso tinha quatro defeitos:
--   1. Com RLS, delete bloqueado devolve sucesso com 0 linhas e sem erro: a tela dizia "excluído" e nada acontecia.
--   2. Não existe FK de clientes_crm.funil_id para crm_funis (04_chaves_estrangeiras.sql). Apagar o funil fisicamente
--      deixaria os cards órfãos, invisíveis em qualquer Kanban.
--   3. vendedores_whatsapp.funil_id aponta para o funil: o webhook continuaria criando cards no funil excluído.
--   4. Exclusão física destrói o histórico (crm_funil_etapas é ON DELETE CASCADE) e a auditoria.
--
-- REGRAS (todas no banco, a tela só pergunta e imprime)
--   - Só Admin (ic_eh_admin()). Qualquer outro perfil recebe erro 42501, não "0 linhas".
--   - Funil com cards (incluindo fechados e perdidos) ou números de WhatsApp vinculados: bloqueia, a menos que
--     p_destino seja informado. Com destino, move TUDO numa única transação e só então exclui.
--   - Último funil ativo não pode ser excluído.
--   - Exclusão é lógica: ativo = false, excluido_em, excluido_por. Etapas e eventos de jornada ficam preservados.
--   - Cada card movido ganha linha na linha do tempo (crm_historico) e a auditoria registra SOFT_DELETE do funil.
--   - Etapa que não existe no funil de destino cai na primeira etapa dele; 'perdido' e as chaves comuns
--     (cliente_novo, cliente_antigo, fechado) são mantidas.
--   - Telefone que já tem card vivo no funil de destino bloqueia a movimentação (índice crm_card_unico_por_funil).

-- =====================================================================
-- 1. Colunas de exclusão lógica
-- =====================================================================
alter table public.crm_funis add column if not exists excluido_em timestamptz;
alter table public.crm_funis add column if not exists excluido_por text;
create index if not exists crm_funis_nao_excluidos_idx on public.crm_funis (ordem) where excluido_em is null;

-- =====================================================================
-- 2. Auditoria: crm_funis passa pelo Histórico de Alterações
--    (audit_trigger_func só reconhece SOFT_DELETE por deleted_at; aqui o marcador é excluido_em)
-- =====================================================================
create or replace function public.ic_audit_funis()
returns trigger
language plpgsql
as $$
declare
  v_op text;
  v_extra jsonb := nullif(current_setting('ic.audit_extra', true), '')::jsonb;
  v_antes jsonb;
  v_depois jsonb;
  v_user text;
  v_id text;
begin
  begin v_user := auth.uid()::text; exception when others then v_user := null; end;
  if tg_op = 'INSERT' then
    v_op := 'INSERT'; v_depois := to_jsonb(new); v_id := new.id::text;
  elsif tg_op = 'UPDATE' then
    if new.excluido_em is not null and old.excluido_em is null then v_op := 'SOFT_DELETE';
    elsif new.excluido_em is null and old.excluido_em is not null then v_op := 'RESTORE';
    else v_op := 'UPDATE'; end if;
    v_antes := to_jsonb(old); v_depois := to_jsonb(new); v_id := new.id::text;
  else
    v_op := 'DELETE'; v_antes := to_jsonb(old); v_id := old.id::text;
  end if;
  -- contexto da operação (destino, quantidade de cards movidos), preenchido pela RPC na mesma transação
  if v_extra is not null and v_depois is not null then v_depois := v_depois || jsonb_build_object('_exclusao', v_extra); end if;
  begin
    insert into public.audit_log_critico (tabela, operacao, registro_id, user_id, dados_antes, dados_depois)
    values ('crm_funis', v_op, v_id, v_user, v_antes, v_depois);
  exception when others then null;  -- auditoria não trava a operação real (mesma regra da auditoria base)
  end;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_crm_funis on public.crm_funis;
create trigger trg_audit_crm_funis after insert or update or delete on public.crm_funis
  for each row execute function public.ic_audit_funis();

-- =====================================================================
-- 3. ic_funil_resumo: o que a tela precisa saber ANTES de perguntar
-- =====================================================================
create or replace function public.ic_funil_resumo(p_funil uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_f public.crm_funis;
  v_ativos int;
begin
  if not public.ic_eh_admin() then
    raise exception 'Somente administradores podem excluir funis.' using errcode = '42501';
  end if;
  select * into v_f from public.crm_funis where id = p_funil and excluido_em is null;
  if not found then raise exception 'Funil não encontrado.' using errcode = 'P0002'; end if;
  select count(*) into v_ativos from public.crm_funis where ativo is true and excluido_em is null;
  return jsonb_build_object(
    'id', v_f.id,
    'nome', v_f.nome,
    'ativo', coalesce(v_f.ativo, false),
    'cards', (select count(*) from public.clientes_crm where funil_id = p_funil),
    'numeros_whatsapp', (select count(*) from public.vendedores_whatsapp where funil_id = p_funil),
    'ultimo_ativo', coalesce(v_f.ativo, false) and v_ativos <= 1,
    'destinos', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'nome', d.nome) order by d.ordem, d.nome)
                            from public.crm_funis d
                           where d.id <> p_funil and d.ativo is true and d.excluido_em is null), '[]'::jsonb)
  );
end;
$$;

-- =====================================================================
-- 4. ic_funil_excluir: valida, move (se pedido) e exclui logicamente, tudo numa transação
-- =====================================================================
create or replace function public.ic_funil_excluir(p_funil uuid, p_destino uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_f public.crm_funis;
  v_dest public.crm_funis;
  v_dest_nome text;   -- v_dest só é atribuído quando há destino; ler campo de record não atribuído é erro em PL/pgSQL
  v_quem text := coalesce((public.ic_usuario_atual()).email, 'sistema');
  v_ativos int;
  v_cards int;
  v_numeros int;
  v_conflitos int;
  v_primeira text;
  v_movidos int := 0;
begin
  if not public.ic_eh_admin() then
    raise exception 'Somente administradores podem excluir funis.' using errcode = '42501';
  end if;

  select * into v_f from public.crm_funis where id = p_funil for update;
  if not found or v_f.excluido_em is not null then
    raise exception 'Funil não encontrado.' using errcode = 'P0002';
  end if;

  select count(*) into v_ativos from public.crm_funis where ativo is true and excluido_em is null;
  if coalesce(v_f.ativo, false) and v_ativos <= 1 then
    raise exception 'Este é o último funil ativo e não pode ser excluído.' using errcode = 'P0001';
  end if;

  select count(*) into v_cards from public.clientes_crm where funil_id = p_funil;
  select count(*) into v_numeros from public.vendedores_whatsapp where funil_id = p_funil;

  if (v_cards > 0 or v_numeros > 0) and p_destino is null then
    raise exception 'Este funil tem % card(s)%. Mova-os para outro funil antes de excluir.',
      v_cards, case when v_numeros > 0 then ' e ' || v_numeros || ' número(s) de WhatsApp vinculado(s)' else '' end
      using errcode = 'P0001';
  end if;

  if p_destino is not null then
    if p_destino = p_funil then
      raise exception 'O funil de destino precisa ser diferente do funil excluído.' using errcode = 'P0001';
    end if;
    select * into v_dest from public.crm_funis where id = p_destino and ativo is true and excluido_em is null for share;
    if not found then
      raise exception 'Funil de destino não encontrado ou inativo.' using errcode = 'P0002';
    end if;
    v_dest_nome := v_dest.nome;

    -- trava de card único por telefone e funil: conflito aborta antes de mexer em qualquer coisa
    select count(*) into v_conflitos
      from public.clientes_crm a
      join public.clientes_crm b on b.telefone_norm = a.telefone_norm and b.funil_id = p_destino
     where a.funil_id = p_funil
       and a.deleted_at is null and a.mesclado_para is null and a.telefone_norm is not null
       and b.deleted_at is null and b.mesclado_para is null;
    if v_conflitos > 0 then
      raise exception '% card(s) deste funil têm o mesmo telefone de um card já existente em "%". Resolva a duplicidade (mescla) antes de mover.',
        v_conflitos, v_dest.nome using errcode = 'P0001';
    end if;

    select e.nome into v_primeira from public.crm_funil_etapas e where e.funil_id = p_destino order by e.ordem, e.nome limit 1;
    v_primeira := coalesce(v_primeira, 'cliente_novo');

    -- linha do tempo (antes do update, para registrar a etapa de origem)
    insert into public.crm_historico (cliente_id, etapa_anterior, etapa_nova, usuario_nome, descricao, tipo)
    select c.id, c.etapa,
           case when c.etapa = 'perdido' or exists (select 1 from public.crm_funil_etapas e where e.funil_id = p_destino and e.nome = c.etapa) then c.etapa else v_primeira end,
           v_quem,
           'Funil "' || v_f.nome || '" excluído: card movido para "' || v_dest.nome || '"',
           'automatico'
      from public.clientes_crm c
     where c.funil_id = p_funil and c.deleted_at is null;

    begin
      update public.clientes_crm c
         set funil_id = p_destino,
             etapa = case when c.etapa = 'perdido' or exists (select 1 from public.crm_funil_etapas e where e.funil_id = p_destino and e.nome = c.etapa) then c.etapa else v_primeira end,
             updated_at = now()
       where c.funil_id = p_funil;
      get diagnostics v_movidos = row_count;
    exception when unique_violation then
      raise exception 'Não foi possível mover: há telefones duplicados no funil de destino "%".', v_dest.nome using errcode = 'P0001';
    end;

    update public.vendedores_whatsapp set funil_id = p_destino, updated_at = now() where funil_id = p_funil;
  end if;

  update public.users set funil_padrao = null where funil_padrao = p_funil;

  -- contexto para a auditoria (lido por ic_audit_funis na mesma transação)
  perform set_config('ic.audit_extra', jsonb_build_object('destino_id', p_destino, 'destino_nome', v_dest_nome, 'cards_movidos', v_movidos, 'numeros_whatsapp_repontados', v_numeros, 'por', v_quem)::text, true);

  update public.crm_funis
     set ativo = false, excluido_em = now(), excluido_por = v_quem, updated_at = now()
   where id = p_funil;
  if not found then
    raise exception 'O funil não foi excluído (nenhuma linha afetada).' using errcode = 'P0001';
  end if;
  perform set_config('ic.audit_extra', '', true);

  return jsonb_build_object('ok', true, 'funil', v_f.nome, 'cards_movidos', v_movidos, 'destino', v_dest_nome, 'numeros_whatsapp_repontados', v_numeros);
end;
$$;

comment on function public.ic_funil_excluir(uuid, uuid) is
  'IC: exclusão lógica de funil, só Admin. Com cards ou números de WhatsApp vinculados exige p_destino e move tudo na mesma transação. Bloqueia o último funil ativo.';

revoke execute on function public.ic_funil_excluir(uuid, uuid) from public, anon;
revoke execute on function public.ic_funil_resumo(uuid) from public, anon;
grant execute on function public.ic_funil_excluir(uuid, uuid) to authenticated;
grant execute on function public.ic_funil_resumo(uuid) to authenticated;

-- ROLLBACK:
--   drop trigger if exists trg_audit_crm_funis on public.crm_funis;
--   drop function if exists public.ic_audit_funis();
--   drop function if exists public.ic_funil_excluir(uuid, uuid);
--   drop function if exists public.ic_funil_resumo(uuid);
--   drop index if exists public.crm_funis_nao_excluidos_idx;
--   -- as colunas só podem ser removidas se nenhum funil foi excluído logicamente; do contrário, restaurar antes:
--   --   update public.crm_funis set ativo = true, excluido_em = null, excluido_por = null where excluido_em is not null;
--   alter table public.crm_funis drop column if exists excluido_por, drop column if exists excluido_em;
