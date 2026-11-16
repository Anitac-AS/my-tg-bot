// 檔案：api/related.js
// GET ?id=123&limit=5 → { data: [{ id, title, summary, tags, attachments, created_at, similarity }] }
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const id = url.searchParams.get("id");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "5", 10) || 5, 1), 10);
  if (!id) return res.status(400).json({ error: "缺少 id" });

  const { data, error } = await supabase.rpc("mm_related_notes", {
    p_id: String(id), p_limit: limit,
    p_min_similarity: Number(process.env.RELATED_MIN_SIMILARITY) || 0.6,
  });
  if (error) {
    console.error("Related error:", error);
    return res.status(500).json({ error: "查詢相關筆記失敗" });
  }
  return res.status(200).json({ data: data || [] });
}
