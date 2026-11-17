-- ============================================================
-- 書書小口袋 — Phase 3：重溫＋每日推播
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可（可重複執行）
-- ============================================================

-- 1) 推播用欄位
alter table public.notes
  add column if not exists resurface_opt_out boolean not null default false,   -- 「以後別推」
  add column if not exists last_resurfaced_at timestamptz;                     -- 上次被推播的時間

-- 2) 往年的今天（台北時間），可前後放寬 p_window 天
--    p_for_push = true 時排除「以後別推」與 60 天內推過的
create or replace function public.mm_on_this_day(
  p_window   int     default 0,
  p_limit    int     default 5,
  p_for_push boolean default false
) returns jsonb
language sql
stable
set search_path = public
as $$
  with today as (select (now() at time zone 'Asia/Taipei')::date as d),
  days as (
    select to_char((select d from today) + k, 'MM-DD') as md
    from generate_series(-greatest(p_window, 0), greatest(p_window, 0)) as k
  ),
  hits as (
    select n.*,
           extract(year from (select d from today))::int
             - extract(year from (n.created_at at time zone 'Asia/Taipei'))::int as years_ago
    from public.notes n
    where to_char(n.created_at at time zone 'Asia/Taipei', 'MM-DD') in (select md from days)
      and extract(year from (n.created_at at time zone 'Asia/Taipei')) < extract(year from (select d from today))
      and (not p_for_push or (
            not n.resurface_opt_out
            and (n.last_resurfaced_at is null or n.last_resurfaced_at < now() - interval '60 days')))
    order by random()
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  )
  select coalesce(jsonb_agg(to_jsonb(h) - 'embedding' order by h.years_ago, h.created_at desc), '[]'::jsonb)
  from hits h;
$$;

-- 3) 隨機一則：優先挑 14 天前的舊筆記；不夠時才放寬
--    p_for_push = true 時排除「以後別推」與 60 天內推過的
create or replace function public.mm_random_note(
  p_exclude  text    default null,
  p_for_push boolean default false
) returns jsonb
language sql
volatile
set search_path = public
as $$
  select coalesce(
    (select to_jsonb(n) - 'embedding' from public.notes n
      where (p_exclude is null or n.id::text <> p_exclude)
        and n.created_at < now() - interval '14 days'
        and (not p_for_push or (
              not n.resurface_opt_out
              and (n.last_resurfaced_at is null or n.last_resurfaced_at < now() - interval '60 days')))
      order by random() limit 1),
    (select to_jsonb(n) - 'embedding' from public.notes n
      where (p_exclude is null or n.id::text <> p_exclude)
        and (not p_for_push or not n.resurface_opt_out)
      order by random() limit 1)
  );
$$;

-- 4) 只允許後端（service_role）呼叫
revoke execute on function public.mm_on_this_day(int, int, boolean) from public, anon, authenticated;
revoke execute on function public.mm_random_note(text, boolean) from public, anon, authenticated;
grant  execute on function public.mm_on_this_day(int, int, boolean) to service_role;
grant  execute on function public.mm_random_note(text, boolean) to service_role;
