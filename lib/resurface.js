// 重溫：挑一則舊筆記、組成 Telegram 訊息
import { supabase } from "./supabase.js";
import { sendMessage, escapeHtml } from "./telegram.js";

export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
  return host ? `https://${host}` : "";
}

// 推播挑選：先找往年的今天（前後 1 天），沒有就隨機挑一則舊筆記
export async function pickForPush(excludeId = null) {
  const { data: days, error: e1 } = await supabase.rpc("mm_on_this_day", { p_window: 1, p_limit: 5, p_for_push: true });
  if (e1) throw e1;
  const onDay = (days || []).find(r => String(r.id) !== String(excludeId));
  if (onDay) return { row: onDay, reason: "onThisDay" };

  const { data: rnd, error: e2 } = await supabase.rpc("mm_random_note", {
    p_exclude: excludeId == null ? null : String(excludeId), p_for_push: true,
  });
  if (e2) throw e2;
  return rnd ? { row: rnd, reason: "random" } : null;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
}

export function buildMessage({ row, reason }, base) {
  const tags = (Array.isArray(row.tags) ? row.tags : []).map(t => `#${t}`).join(" ");
  const when = reason === "onThisDay" && row.years_ago
    ? `${row.years_ago} 年前的這幾天（${fmtDate(row.created_at)}）存的`
    : `${fmtDate(row.created_at)} 存的`;
  const text = [
    "<b>今天重溫這則</b>",
    `<i>${escapeHtml(when)}</i>`,
    "",
    `<b>${escapeHtml(row.title || "無標題記錄")}</b>`,
    escapeHtml(row.summary || ""),
    tags ? `\n${escapeHtml(tags)}` : "",
  ].filter(s => s !== null).join("\n").trim();

  const buttons = [];
  if (base) buttons.push([{ text: "在網頁打開", url: `${base}/?note=${encodeURIComponent(row.id)}` }]);
  buttons.push([
    { text: "再來一則", callback_data: `rs:more:${row.id}` },
    { text: "以後別推這則", callback_data: `rs:off:${row.id}` },
  ]);
  return { text, replyMarkup: { inline_keyboard: buttons } };
}

// 挑一則、送出、記錄推播時間
export async function pushOne(chatId, base, excludeId = null) {
  const picked = await pickForPush(excludeId);
  if (!picked) {
    await sendMessage(chatId, "口袋裡還沒有可以重溫的筆記。");
    return null;
  }
  const { text, replyMarkup } = buildMessage(picked, base);
  await sendMessage(chatId, text, replyMarkup);
  const { error } = await supabase.from("notes")
    .update({ last_resurfaced_at: new Date().toISOString() }).eq("id", picked.row.id);
  if (error) console.error("Mark resurfaced failed:", error);
  return picked;
}
