// 檔案：api/tags.js
// GET              → { data: [{ tag, count }] }（全庫統計）
// PATCH            body: { from, to } → 把所有筆記的 from 改成 to（to 已存在就等於合併）
// DELETE ?tag=xxx  → 從所有筆記移除這個標籤（筆記本身不刪）
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";

function cleanTag(t) {
  return typeof t === "string" ? t.trim().replace(/^#/, "").slice(0, 30) : "";
}

// 找出所有含這個標籤的筆記（分頁抓完）
async function notesWithTag(tag) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await supabase.rpc("mm_search_notes", {
      p_q: "", p_tags: [tag], p_type: "", p_limit: 100, p_offset: offset,
    });
    if (error) throw error;
    const page = data?.data || [];
    rows.push(...page);
    if (page.length < 100) break;
  }
  return rows;
}

async function rewriteTags(rows, mapFn) {
  let changed = 0;
  for (const row of rows) {
    const before = Array.isArray(row.tags) ? row.tags : [];
    const after = [];
    for (const t of before.map(mapFn)) if (t && !after.includes(t)) after.push(t);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    const { error } = await supabase.from("notes").update({ tags: after }).eq("id", row.id);
    if (error) throw error;
    changed++;
  }
  return changed;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  try {
    if (req.method === "GET") {
      const { data, error } = await supabase.rpc("mm_tag_counts");
      if (error) throw error;
      return res.status(200).json({
        data: (data || []).map(r => ({ tag: r.tag, count: Number(r.cnt) })),
      });
    }

    if (req.method === "PATCH") {
      const from = cleanTag(req.body?.from);
      const to = cleanTag(req.body?.to);
      if (!from || !to) return res.status(400).json({ error: "缺少標籤名稱" });
      if (from === to) return res.status(200).json({ changed: 0 });
      const changed = await rewriteTags(await notesWithTag(from), t => (t === from ? to : t));
      return res.status(200).json({ changed });
    }

    if (req.method === "DELETE") {
      const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
      const tag = cleanTag(url.searchParams.get("tag"));
      if (!tag) return res.status(400).json({ error: "缺少標籤名稱" });
      const changed = await rewriteTags(await notesWithTag(tag), t => (t === tag ? null : t));
      return res.status(200).json({ changed });
    }

    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (err) {
    console.error("Tags API error:", err);
    return res.status(500).json({ error: "標籤更新失敗" });
  }
}
