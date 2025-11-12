// 檔案：api/webhook.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---- 可選：驗證 Telegram Secret Token ----
function verifyTelegramSecretToken(req) {
  const expected = process.env.TG_SECRET_TOKEN;
  if (!expected) return true;
  const got = req.headers["x-telegram-bot-api-secret-token"];
  return typeof got === "string" && got === expected;
}

// ---- 初始化 Gemini（v1 模型名）----
const MODEL_NAME = "gemini-1.5-flash-latest";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: MODEL_NAME,
  systemInstruction: `
你是一位資料歸檔專家，請分析以下內容，產生一個 JSON 物件：
{
  "title": "一句簡短吸引人的標題",
  "summary": "一段不超過 100 字的摘要",
  "tags": ["標籤1","標籤2","標籤3","標籤4","標籤5"]
}
請只輸出純 JSON，勿包含 Markdown 或任何額外文字。`
});

// ---- 回傳訊息到 Telegram ----
async function replyToTelegram({ chatId, text }) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`sendMessage failed: ${r.status} ${r.statusText} ${t}`);
  }
}

// ---- 主處理器 ----
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // 印出 Node 版本與模型名（確認 runtime）
    console.log("Node version:", process.versions.node);
    console.log("GenAI model name:", MODEL_NAME);

    if (!verifyTelegramSecretToken(req)) {
      return res.status(401).send("Unauthorized");
    }

    console.log("TELEGRAM_WEBHOOK_PAYLOAD:", JSON.stringify(req.body, null, 2));

    const msg = req.body?.message || req.body?.edited_message;
    const messageText = msg?.text;
    const chatId = msg?.chat?.id;

    if (!chatId) {
      console.log("No chatId. Ack only.");
      return res.status(200).send("OK");
    }

    if (!messageText) {
      console.log("No text message found. Skipping AI.");
      await replyToTelegram({
        chatId,
        text: "我目前只處理純文字訊息喔～可以直接貼一段文字給我整理。"
      });
      return res.status(200).send("OK");
    }

    console.log("Sending to Gemini:", messageText);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: messageText }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const raw = result.response.text();
    console.log("GEMINI_RESPONSE_RAW:", raw);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("AI returned non-JSON:", raw);
      await replyToTelegram({
        chatId,
        text: "抱歉，我拿到的 AI 回覆不是有效的 JSON，請再試一次或換一段文字。"
      });
      return res.status(200).send("OK");
    }

    console.log("GEMINI_RESPONSE_JSON:", parsed);

    const pretty = [
      `🧠 <b>AI 摘要完成</b>`,
      `\n<b>標題</b>：${parsed.title ?? ""}`,
      `\n<b>摘要</b>：${parsed.summary ?? ""}`,
      `\n<b>標籤</b>：${Array.isArray(parsed.tags) ? parsed.tags.join(", ") : ""}`
    ].join("");

    await replyToTelegram({ chatId, text: pretty });

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing webhook:", error);
    // 避免 Telegram 重送
    return res.status(200).send("OK");
  }
}
