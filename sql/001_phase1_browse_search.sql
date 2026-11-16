-- ============================================================
-- Shu's MyMind — Phase 1：瀏覽與搜尋改版
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可（可重複執行）
-- ============================================================

-- 1) 置頂欄位
alter table public.notes
  add column if not exists pinned boolean not null default false;

create index if not exists notes_pinned_created_idx
  on public.notes (pinned desc, created_at desc);

-- 2) 搜尋函式：關鍵字（空白分隔 = AND）＋ 多標籤（AND）＋ 類型 ＋ 分頁
--    回傳 { total, data: [...] }
--    tags / attachments 不論是 text[] 或 jsonb 都能用（統一轉成 jsonb 判斷）
create or replace function public.mm_search_notes(
  p_q      text    default '',
  p_tags   text[]  default '{}',
  p_type   text    default '',
  p_limit  int     default 30,
  p_offset int     default 0
) returns jsonb
language sql
stable
set search_path = public
as $$
  with terms as (
    select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
    from regexp_split_to_table(coalesce(btrim(p_q), ''), '\s+') as t
    where t <> ''
  ),
  base as (
    select n.*,
           case when jsonb_typeof(to_jsonb(n.tags)) = 'array'
                then to_jsonb(n.tags) else '[]'::jsonb end                        as _tags,
           coalesce(to_jsonb(n.attachments) @> '[{"type":"image"}]'::jsonb, false) as _has_img,
           coalesce(n.raw_text, '') ~* 'https?://'                                 as _has_link
    from public.notes n
  ),
  filtered as (
    select b.*
    from base b
    where (coalesce(array_length(p_tags, 1), 0) = 0 or b._tags ?& p_tags)
      and not exists (
        select 1 from terms
        where not (
             coalesce(b.title, '')    ilike terms.pat
          or coalesce(b.summary, '')  ilike terms.pat
          or coalesce(b.raw_text, '') ilike terms.pat
          or b._tags::text            ilike terms.pat
        )
      )
      and (
           coalesce(p_type, '') = ''
        or (p_type = 'image' and b._has_img)
        or (p_type = 'link'  and b._has_link)
        or (p_type = 'text'  and not b._has_img and not b._has_link)
      )
  ),
  page as (
    select * from filtered
    order by pinned desc, created_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'data',  coalesce(
               (select jsonb_agg(to_jsonb(p) - '_tags' - '_has_img' - '_has_link'
                                 order by p.pinned desc, p.created_at desc)
                from page p),
               '[]'::jsonb)
  );
$$;

-- 3) 全庫標籤統計
create or replace function public.mm_tag_counts()
returns table (tag text, cnt bigint)
language sql
stable
set search_path = public
as $$
  select t, count(*)
  from public.notes n
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(to_jsonb(n.tags)) = 'array'
         then to_jsonb(n.tags) else '[]'::jsonb end
  ) as t
  group by t
  order by 2 desc, 1;
$$;

-- 4) 只允許後端（service_role）呼叫，前端匿名 key 不能直接打
revoke execute on function public.mm_search_notes(text, text[], text, int, int) from public, anon, authenticated;
revoke execute on function public.mm_tag_counts() from public, anon, authenticated;
grant  execute on function public.mm_search_notes(text, text[], text, int, int) to service_role;
grant  execute on function public.mm_tag_counts() to service_role;
