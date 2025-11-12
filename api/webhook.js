// 檔案：api/webhook.js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let genAIVersion = "unknown";
try {
  genAIVersion = require("@google/generative-ai/package.json").version;
} catch { /* optional */ }

// ---- 可選：驗證 Telegram Secret Token ----
function verifyTelegramSecretToken(req) {
  const expected = process.env.TG_SECRET_TOKEN;
  if (!expected) return true;
  const got = req.headers["x-telegram-bot-api-secret-token"];
  return typeof got === "string" && got === expected;
}

// ---- 回傳訊息到 Telegram ----
async function replyToTelegram({ chatId, text }) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error(`sendMessage failed: ${r.status} ${r.statusText} ${t}`);
  }
}

// ---- 固定使用 v1 + 1.5-flash-latest ----
const MODEL_NAME = "gemini-1.5-flash-latest";
const systemPrompt = `
你是一位資料歸檔專家，請分析以下內容，產生一個 JSON 物件：
{
  "title": "一句簡短吸引人的標題",
  "summary": "一段不超過 100 字的摘要",
  "tags": ["標籤1","標籤2","標籤3","標籤4","標籤5"]
}
請只輸出純 JSON，勿包含 Markdown 或任何額外文字。`;

// ---- 直打 v1 REST API ----
async function callGeminiV1(messageText) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${key}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: messageText }] }],
    systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: "application/json" },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  console.log("Gemini v1 status:", r.status, r.statusText);
  console.log("Gemini v1 body (first 2KB):", text.slice(0, 2048));

  if (!r.ok) {
    let errDetail = text;
    try {
      const j = JSON.parse(text);
      errDetail = JSON.stringify(j);
    } catch {}
    throw new Error(`Gemini v1 error: ${r.status} ${r.statusText} ${errDetail}`);
  }

  // 正常回應
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini v1 JSON parse failed");
  }
  const out = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  return out;
}

// ---- 主處理器 ----
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    console.log("Node version:", process.versions.node);
    console.log("GenAI SDK installed version (for reference):", genAIVersion);
    console.log("Model name (v1 REST):", MODEL_NAME);

    if (!process.env.GEMINI_API_KEY) {
      console.error("Missing GEMINI_API_KEY");
      return res.status(500).send("Missing GEMINI_API_KEY");
    }
    if (!process.env.BOT_TOKEN) {
      console.error("Missing BOT_TOKEN");
      return res.status(500).send("Missing BOT_TOKEN");
    }
    if (!verifyTelegramSecretToken(req)) return res.status(401).send("Unauthorized");

    console.log("TELEGRAM_WEBHOOK_PAYLOAD:", JSON.stringify(req.body, null, 2));

    const msg = req.body?.message || req.body?.edited_message;
    const messageText = msg?.text;
    const chatId = msg?.chat?.id;

    if (!chatId) {
      console.log("No chatId. Ack only.");
      return res.status(200).send("OK");
    }

    if (!messageText) {
      await replyToTelegram({
        chatId,
        text: "我目前只處理純文字訊息喔～可以直接貼一段文字給我整理。",
      });
      return res.status(200).send("OK");
    }

    console.log("Sending to Gemini (v1 REST):", messageText);

    let raw;
    try {
      raw = await callGeminiV1(messageText);
    } catch (apiErr) {
      console.error("Gemini v1 call error:", apiErr?.message || apiErr);
      await replyToTelegram({ chatId, text: "呼叫 AI 服務時發生錯誤，已記錄詳情。" });
      return res.status(200).send("OK");
    }

    console.log("GEMINI_RESPONSE_RAW:", raw);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("AI returned non-JSON:", raw);
      await replyToTelegram({
        chatId,
        text: "抱歉，我拿到的 AI 回覆不是有效的 JSON，請再試一次或換一段文字。",
      });
      return res.status(200).send("OK");
    }

    console.log("GEMINI_RESPONSE_JSON:", parsed);

    const pretty = [
      `🧠 <b>AI 摘要完成</b>`,
      `\n<b>標題</b>：${parsed.title ?? ""}`,
      `\n<b>摘要</b>：${parsed.summary ?? ""}`,
      `\n<b>標籤</b>：${Array.isArray(parsed.tags) ? parsed.tags.join(", ") : ""}`,
    ].join("");

    await replyToTelegram({ chatId, text: pretty });
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Error processing webhook (top-level):", err);
    return res.status(200).send("OK");
  }
}
