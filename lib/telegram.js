// Telegram Bot API 小工具
const API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

async function call(method, body) {
  if (!process.env.BOT_TOKEN) throw new Error("尚未設定 BOT_TOKEN");
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method} 失敗：${json.description || res.status}`);
  return json.result;
}

export function sendMessage(chatId, text, replyMarkup) {
  return call("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export function answerCallback(callbackQueryId, text) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export function editReplyMarkup(chatId, messageId, replyMarkup) {
  return call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 允許的使用者（ALLOWED_TG_USER_IDS，逗號分隔；未設定則不限制）
export function allowedUserIds() {
  return (process.env.ALLOWED_TG_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
}

export function isAllowedUserId(id) {
  const list = allowedUserIds();
  return !list.length || list.includes(String(id ?? ""));
}
