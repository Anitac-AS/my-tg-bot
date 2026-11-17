// 檔案：api/resurface.js
// GET            → { onThisDay: [...], random: row|null }（首頁重溫卡）
// GET ?random=1&exclude=123 → { random: row|null }（換一則）
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const exclude = url.searchParams.get("exclude");

  try {
    const randomOnly = url.searchParams.get("random") === "1";
    const [days, rnd] = await Promise.all([
      randomOnly ? { data: [] } : supabase.rpc("mm_on_this_day", { p_window: 0, p_limit: 5, p_for_push: false }),
      supabase.rpc("mm_random_note", { p_exclude: exclude || null, p_for_push: false }),
    ]);
    if (days.error) throw days.error;
    if (rnd.error) throw rnd.error;

    // 隨機那則不要跟「往年今天」重複
    const onThisDay = days.data || [];
    let random = rnd.data || null;
    if (random && onThisDay.some(r => String(r.id) === String(random.id))) {
      const again = await supabase.rpc("mm_random_note", { p_exclude: String(random.id), p_for_push: false });
      random = again.data || random;
    }
    return res.status(200).json(randomOnly ? { random } : { onThisDay, random });
  } catch (err) {
    console.error("Resurface error:", err);
    return res.status(500).json({ error: "重溫資料讀取失敗" });
  }
}
