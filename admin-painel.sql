-- GESTOR PRO PAINEL — PAINEL ADMIN DA PLATAFORMA (somente ACRESCENTA objetos; não altera nem apaga nada existente)
-- Rode no Supabase > SQL Editor. Depois do PASSO 1, troque SEU_EMAIL_AQUI e rode o PASSO 2.

-- PASSO 1 — tabelas e funções novas
create table if not exists public.plataforma_admins (user_id uuid primary key, email text, criado_em timestamptz default now());
create table if not exists public.admin_log (id bigserial primary key, em timestamptz default now(), admin_id uuid, empresa_id text, acao text, motivo text, antes jsonb);
alter table public.plataforma_admins enable row level security;  -- sem policies: só as funções abaixo acessam
alter table public.admin_log enable row level security;

create or replace function public._admin_check() returns void language plpgsql security definer set search_path=public,auth as $$
begin
  if auth.uid() is null or not exists (select 1 from public.plataforma_admins where user_id = auth.uid()) then
    raise exception 'Acesso negado: apenas o administrador da plataforma.' using errcode='42501';
  end if;
end $$;

create or replace function public.admin_sou_admin() returns boolean language sql security definer set search_path=public,auth as $$
  select exists (select 1 from public.plataforma_admins where user_id = auth.uid()) $$;

create or replace function public.admin_listar_clientes() returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r jsonb; mt text; q_nome text := 'null'; q_mail text := 'null'; base text; q text;
begin
  perform public._admin_check();
  select table_name into mt from information_schema.columns where table_schema='public' and column_name in ('empresa_id','user_id','papel')
    group by table_name having count(*)=3 order by (table_name ilike '%membro%') desc, table_name limit 1;
  if mt is not null then
    q_mail := format($f$(select u.email from public.%I m join auth.users u on u.id=m.user_id where m.empresa_id::text=a.empresa_id::text and m.papel='dono' limit 1)$f$, mt);
  end if;
  base := $f$select coalesce(jsonb_agg(t.j order by t.j->>'nome', t.j->>'empresa_id'),'[]'::jsonb) from (select to_jsonb(a) || jsonb_build_object(
    'nome', %s, 'email_dono', %s,
    'faturas_pagas', (select count(*) from public.faturas f where f.empresa_id::text=a.empresa_id::text and f.status='paga'),
    'faturas_pendentes', (select count(*) from public.faturas f where f.empresa_id::text=a.empresa_id::text and f.status<>'paga'),
    'ultimo_pagamento', (select max(f.created_at) from public.faturas f where f.empresa_id::text=a.empresa_id::text and f.status='paga'),
    'ultima_acao_admin', (select l.acao from public.admin_log l where l.empresa_id=a.empresa_id::text order by l.id desc limit 1)
  ) j from public.empresa_assinaturas a) t$f$;
  if to_regclass('public.empresas') is not null then
    q_nome := '(select to_jsonb(e)->>''nome'' from public.empresas e where e.id::text=a.empresa_id::text limit 1)';
  end if;
  begin
    execute format(base, q_nome, q_mail) into r;
  exception when others then
    execute format(base, 'null', q_mail) into r;
  end;
  return r;
end $$;

create or replace function public.admin_listar_faturas(p_empresa text) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r jsonb;
begin
  perform public._admin_check();
  select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at desc),'[]'::jsonb) into r from public.faturas f where f.empresa_id::text = p_empresa;
  return r;
end $$;

-- liberar / reativar: dá p_dias de acesso pago. bloquear: encerra os prazos. Guarda o estado anterior em admin_log.
-- v2: lê os status aceitos pela constraint CHECK de empresa_assinaturas (se houver) e só tenta valores permitidos;
--     se o banco recusar, devolve a mensagem real do erro em vez de falhar em silêncio.
create or replace function public.admin_definir_acesso(p_empresa text, p_acao text, p_dias int default 30, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path=public,auth as $$
declare s text; n int := 0; antes jsonb; permitidos text[] := '{}'; cand text[]; def text; ult_erro text;
begin
  perform public._admin_check();
  if p_acao not in ('liberar','reativar','bloquear') then raise exception 'Ação inválida.'; end if;
  select to_jsonb(a) into antes from public.empresa_assinaturas a where a.empresa_id::text = p_empresa;
  if antes is null then raise exception 'Cliente sem assinatura registrada.'; end if;

  for def in select pg_get_constraintdef(oid) from pg_constraint
             where conrelid='public.empresa_assinaturas'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%status%' loop
    permitidos := permitidos || coalesce((select array_agg(m[1]) from regexp_matches(def, '''([^'']+)''', 'g') m), '{}'::text[]);
  end loop;

  cand := case when p_acao='bloquear' then array['bloqueada','bloqueado','suspensa','cancelada','inadimplente'] else array['ativa','ativo'] end;
  if cardinality(permitidos) > 0 then
    cand := array(select x from unnest(cand) with ordinality t(x,o) where x = any(permitidos) order by o);
    if cardinality(cand) = 0 then
      raise exception 'O banco só aceita estes status: %. Ajuste a lista de candidatos em admin_definir_acesso.', array_to_string(permitidos, ', ');
    end if;
  end if;

  foreach s in array cand loop
    begin
      if p_acao='bloquear' then
        update public.empresa_assinaturas set status=s, teste_fim=least(teste_fim, now()-interval '1 second'), periodo_atual_fim=least(periodo_atual_fim, now()-interval '1 second') where empresa_id::text=p_empresa;
      else
        update public.empresa_assinaturas set status=s, periodo_atual_fim=greatest(now(), coalesce(periodo_atual_fim, now())) + make_interval(days => greatest(p_dias,1)) where empresa_id::text=p_empresa;
      end if;
      get diagnostics n = row_count;
    exception when others then
      n := 0; get stacked diagnostics ult_erro = message_text;
    end;
    exit when n > 0;
  end loop;
  if n = 0 then raise exception 'Não foi possível alterar o acesso. Último erro do banco: %', coalesce(ult_erro, 'nenhuma linha atualizada'); end if;
  insert into public.admin_log(admin_id, empresa_id, acao, motivo, antes) values (auth.uid(), p_empresa, p_acao, p_motivo, antes);
  return jsonb_build_object('ok', true, 'status_aplicado', s);
end $$;

revoke all on function public._admin_check(), public.admin_sou_admin(), public.admin_listar_clientes(), public.admin_listar_faturas(text), public.admin_definir_acesso(text,text,int,text) from public, anon;
grant execute on function public.admin_sou_admin(), public.admin_listar_clientes(), public.admin_listar_faturas(text), public.admin_definir_acesso(text,text,int,text) to authenticated;

-- PASSO 2 — seu acesso exclusivo (antes: Authentication > Users > Add user, com o seu e-mail e uma senha forte, "Auto Confirm User" marcado)
-- insert into public.plataforma_admins(user_id,email) select id,email from auth.users where lower(email)=lower('SEU_EMAIL_AQUI') on conflict do nothing;

-- PASSO 3 — conferência de LIBERAR/BLOQUEAR (somente leitura; rode e me envie o resultado se algo falhar)
-- select pg_get_functiondef('public.minha_conta'::regproc);
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.empresa_assinaturas'::regclass;
