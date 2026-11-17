// 檔案：api/linkpreview.js
// 替含網址、還沒抓過預覽的舊筆記補抓連結預覽
// GET  → { remaining }
// POST → 處理一批（5 則）→ { done, failed, remaining }
// 抓到預覽後清掉該筆記的向量，讓「建立語意索引」把網頁標題也算進去
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { firstUrl, fetchLinkPreview } from "../lib/linkpreview.js";

const BATCH = 5;

async function pending(limit) {
  const { data, error } = await supabase.rpc("mm_link_pending", { p_limit: limit });
  if (error) throw error;
  return { remaining: Number(data?.remaining || 0), rows: data?.data || [] };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  try {
    if (req.method === "GET") {
      const { remaining } = await pending(0);
      return res.status(200).json({ remaining });
    }

    if (req.method === "POST") {
      const { rows } = await pending(BATCH);
      const results = await Promise.all(rows.map(async (row) => {
        const url = firstUrl(row.raw_text);
        const preview = await fetchLinkPreview(url);
        const attachments = [...(Array.isArray(row.attachments) ? row.attachments : []),
          preview || { type: "link_failed", url }];
        const patch = preview ? { attachments, embedding: null } : { attachments };
        const { error } = await supabase.from("notes").update(patch).eq("id", row.id);
        if (error) { console.error("Link preview save failed:", error); return "error"; }
        return preview ? "done" : "failed";
      }));
      const { remaining } = await pending(0);
      return res.status(200).json({
        done: results.filter(r => r === "done").length,
        failed: results.filter(r => r !== "done").length,
        remaining,
      });
    }

    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (err) {
    console.error("Link preview error:", err);
    return res.status(500).json({ error: err.message || "補抓連結預覽失敗" });
  }
}
