-- ============================================================
-- 書書小口袋 — 連結預覽：找出還沒抓過預覽的舊筆記
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可（可重複執行）
-- 預覽資料存在既有的 attachments 欄位（{type:"link", url, title, description, image, site}），不需新增欄位
-- ============================================================

create or replace function public.mm_link_pending(p_limit int default 5)
returns jsonb
language sql
stable
set search_path = public
as $$
  with pending as (
    select n.id, n.raw_text, n.attachments, n.created_at
    from public.notes n
    where coalesce(n.raw_text, '') ~* 'https?://'
      and not coalesce(to_jsonb(n.attachments) @> '[{"type":"link"}]'::jsonb, false)
      and not coalesce(to_jsonb(n.attachments) @> '[{"type":"link_failed"}]'::jsonb, false)
  )
  select jsonb_build_object(
    'remaining', (select count(*) from pending),
    'data', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc)
                      from (select * from pending order by created_at desc
                            limit greatest(0, least(coalesce(p_limit, 5), 20))) p), '[]'::jsonb)
  );
$$;

revoke execute on function public.mm_link_pending(int) from public, anon, authenticated;
grant  execute on function public.mm_link_pending(int) to service_role;
