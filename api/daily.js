// 檔案：api/daily.js
// 每日推播：Vercel Cron 每天呼叫一次（vercel.json），挑一則舊筆記傳到 Telegram
// 驗證：Vercel Cron 會帶 Authorization: Bearer <CRON_SECRET>；
//       也可以在已登入網站的瀏覽器打開 /api/daily 手動測試
import { supabase } from "../lib/supabase.js";
import { isAuthed } from "../lib/auth.js";
import { allowedUserIds } from "../lib/telegram.js";
import { pushOne, siteUrl } from "../lib/resurface.js";

function isCron(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!isCron(req) && !isAuthed(req)) return res.status(401).json({ error: "Unauthorized" });
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const chatId = process.env.DAILY_CHAT_ID || allowedUserIds()[0];
  if (!chatId) return res.status(500).json({ error: "請設定 DAILY_CHAT_ID 或 ALLOWED_TG_USER_IDS" });

  try {
    const picked = await pushOne(chatId, siteUrl(req));
    return res.status(200).json({ ok: true, sent: picked ? { id: picked.row.id, title: picked.row.title, reason: picked.reason } : null });
  } catch (err) {
    console.error("Daily push error:", err);
    return res.status(500).json({ error: err.message || "推播失敗" });
  }
}
