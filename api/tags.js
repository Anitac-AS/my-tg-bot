// 檔案：api/tags.js
// GET → { data: [{ tag, count }] }（全庫統計）
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const { data, error } = await supabase.rpc("mm_tag_counts");
  if (error) {
    console.error("Tag counts error:", error);
    return res.status(500).json({ error: "Supabase query error" });
  }
  return res.status(200).json({
    data: (data || []).map(r => ({ tag: r.tag, count: Number(r.cnt) })),
  });
}
