-- ============================================================
-- Shu's MyMind — Phase 2：語意搜尋＋相關筆記
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可（可重複執行）
-- ============================================================

-- 1) 向量擴充與欄位（Gemini embedding，768 維）
-- Supabase 預設把擴充裝在 extensions schema（SQL Editor 的 search_path 已包含）
create extension if not exists vector with schema extensions;

alter table public.notes
  add column if not exists embedding vector(768);

create index if not exists notes_embedding_hnsw_idx
  on public.notes using hnsw (embedding vector_cosine_ops);

-- 2) 混合搜尋：關鍵字命中 ＋ 語意相近，用 RRF 合併排名
--    回傳 { total, data: [...] }，每筆多一個 _match: 'keyword' | 'semantic'
create or replace function public.mm_hybrid_search(
  p_q              text,
  p_embedding      vector(768),
  p_tags           text[]  default '{}',
  p_type           text    default '',
  p_limit          int     default 30,
  p_offset         int     default 0,
  p_min_similarity float   default 0.6,
  p_max_semantic   int     default 30,
  p_rel_gap        float   default 0.1
) returns jsonb
language sql
stable
set search_path = public, extensions
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
    select b.* from base b
    where (coalesce(array_length(p_tags, 1), 0) = 0 or b._tags ?& p_tags)
      and (
           coalesce(p_type, '') = ''
        or (p_type = 'image' and b._has_img)
        or (p_type = 'link'  and b._has_link)
        or (p_type = 'text'  and not b._has_img and not b._has_link)
      )
  ),
  kw as (
    select f.id, row_number() over (order by f.created_at desc) as rk
    from filtered f
    where exists (select 1 from terms)
      and not exists (
        select 1 from terms
        where not (
             coalesce(f.title, '')    ilike terms.pat
          or coalesce(f.summary, '')  ilike terms.pat
          or coalesce(f.raw_text, '') ilike terms.pat
          or f._tags::text            ilike terms.pat
        )
      )
  ),
  sem_raw as (
    select f.id, 1 - (f.embedding <=> p_embedding) as sim
    from filtered f
    where p_embedding is not null and f.embedding is not null
    order by f.embedding <=> p_embedding
    limit greatest(p_max_semantic, 1)
  ),
  -- 絕對門檻 ＋ 與最相近那筆的差距不超過 p_rel_gap，避免列出一堆不相干的
  sem as (
    select s.id, row_number() over (order by s.sim desc) as rk
    from sem_raw s
    where s.sim >= greatest(p_min_similarity, (select max(sim) from sem_raw) - p_rel_gap)
  ),
  fused as (
    select coalesce(kw.id, sem.id) as id,
           coalesce(1.0 / (60 + kw.rk), 0) * 1.2 + coalesce(1.0 / (60 + sem.rk), 0) as score,
           case when kw.id is not null then 'keyword' else 'semantic' end as match
    from kw full outer join sem on kw.id = sem.id
  ),
  page as (
    select f.*, fu.score, fu.match
    from fused fu join filtered f on f.id = fu.id
    order by fu.score desc, f.created_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from fused),
    'data',  coalesce(
               (select jsonb_agg(
                         (to_jsonb(p) - '_tags' - '_has_img' - '_has_link' - 'embedding' - 'score' - 'match')
                         || jsonb_build_object('_match', p.match)
                         order by p.score desc, p.created_at desc)
                from page p),
               '[]'::jsonb)
  );
$$;

-- 3) 相關筆記：同一則筆記的最近鄰
create or replace function public.mm_related_notes(
  p_id             text,
  p_limit          int   default 5,
  p_min_similarity float default 0.6
) returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  with src as (select embedding from public.notes where id::text = p_id and embedding is not null),
  nn as (
    select n.*, 1 - (n.embedding <=> (select embedding from src)) as similarity
    from public.notes n
    where n.id::text <> p_id and n.embedding is not null and exists (select 1 from src)
    order by n.embedding <=> (select embedding from src)
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  )
  select coalesce(jsonb_agg(to_jsonb(nn) - 'embedding' order by nn.similarity desc), '[]'::jsonb)
  from nn
  where nn.similarity >= p_min_similarity;
$$;

-- 4) 舊的搜尋函式回傳時不要帶出 embedding（太大）
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
               (select jsonb_agg(to_jsonb(p) - '_tags' - '_has_img' - '_has_link' - 'embedding'
                                 order by p.pinned desc, p.created_at desc)
                from page p),
               '[]'::jsonb)
  );
$$;

-- 5) 只允許後端（service_role）呼叫
revoke execute on function public.mm_hybrid_search(text, vector, text[], text, int, int, float, int, float) from public, anon, authenticated;
revoke execute on function public.mm_related_notes(text, int, float) from public, anon, authenticated;
grant  execute on function public.mm_hybrid_search(text, vector, text[], text, int, int, float, int, float) to service_role;
grant  execute on function public.mm_related_notes(text, int, float) to service_role;
