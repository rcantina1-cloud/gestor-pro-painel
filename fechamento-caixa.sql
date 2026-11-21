-- GESTOR PRO PAINEL — GRAVAÇÃO DO VALOR CONTADO NO FECHAMENTO DO CAIXA (somente ACRESCENTA; não altera fechar_caixa_v2)
-- Rode no Supabase > SQL Editor, uma vez. O app já chama gravar_contagem_caixa logo após fechar_caixa_v2().
-- Se esta função não existir, o app ainda fecha o caixa e avisa na tela que o valor contado não foi gravado.

alter table public.caixa_sessoes add column if not exists valor_contado numeric(12,2);
alter table public.caixa_sessoes add column if not exists diferenca numeric(12,2);

create or replace function public.gravar_contagem_caixa(p_valor_contado numeric) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r jsonb;
begin
  if auth.uid() is null then raise exception 'Não autenticado.' using errcode='42501'; end if;
  if p_valor_contado is null or p_valor_contado < 0 then raise exception 'Valor contado inválido.'; end if;
  -- grava na sessão fechada mais recente DESTE usuário que ainda não tem contagem (nunca sobrescreve)
  update public.caixa_sessoes c
     set valor_contado = round(p_valor_contado, 2),
         diferenca     = round(p_valor_contado - coalesce(c.esperado, 0), 2)
   where c.ctid = (select c2.ctid from public.caixa_sessoes c2
                    where c2.user_id = auth.uid() and c2.status <> 'aberto' and c2.valor_contado is null
                    order by c2.aberto_em desc limit 1)
  returning to_jsonb(c) into r;
  if r is null then raise exception 'Nenhuma sessão fechada sem contagem para este usuário.'; end if;
  return jsonb_build_object('ok', true, 'valor_contado', r->'valor_contado', 'diferenca', r->'diferenca');
end $$;

revoke all on function public.gravar_contagem_caixa(numeric) from public, anon;
grant execute on function public.gravar_contagem_caixa(numeric) to authenticated;

-- Conferência (somente leitura): sessões recentes com contagem
-- select aberto_em, status, esperado, valor_contado, diferenca from public.caixa_sessoes order by aberto_em desc limit 10;
