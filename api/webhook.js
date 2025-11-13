// 檔案：api/webhook.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

// ====== Gemini 設定 ======
const MODEL_NAME = "gemini-2.0-flash";

const SYSTEM_PROMPT = `
你是一位資料歸檔專家。請分析以下內容，產生一個 JSON 物件，包含：

{
  "title": "一句簡短吸引人的標題",
  "summary": "一段不超過 100 字的摘要",
  "tags": ["標籤1","標籤2","標籤3","標籤4","標籤5"]
}
重要規則：
1. 標籤請優先從以下固定列表中選 1~5 個最相關者：
   ["教育","親子","AI","資訊","健康","旅遊","趣味","購物",興趣]

2. 若內容真的無法匹配上述分類，才允許新增新的標籤，但請控制在 1~2 個。

3. 標籤盡量使用單詞或短片語，避免出現完整句子。
請只輸出「純 JSON」，不要有 Markdown、說明文字或 \`\`\` 區塊。
`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ====== Supabase 設定（Server 端）=====
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (!supabase) {
  console.error("Supabase client not initialized. Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
}

// ====== Telegram secret token 驗證（有設才會啟用）======
function verifyTelegramSecretToken(req) {
  const expected = process.env.TG_SECRET_TOKEN;
  if (!expected) return true;
  const got = req.headers["x-telegram-bot-api-secret-token"];
  return typeof got === "string" && got === expected;
}

// ====== 回覆訊息給 Telegram ======
async function replyToTelegram({ chatId, text }) {
  if (!process.env.BOT_TOKEN) {
    console.error("Missing BOT_TOKEN env var");
    return;
  }

  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error(`sendMessage failed: ${r.status} ${r.statusText} ${t || "(no body)"}`);
  }
}

// ====== Webhook 主處理器 ======
export default async function handler(req, res) {
  let chatId; // 給 catch 用

  try {
    console.log("Node version:", process.version);

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error("Missing GEMINI_API_KEY env var");
      return res.status(500).send("GEMINI_API_KEY not configured");
    }
    if (!process.env.BOT_TOKEN) {
      console.error("Missing BOT_TOKEN env var");
      return res.status(500).send("BOT_TOKEN not configured");
    }

    console.log("GenAI model name (SDK):", MODEL_NAME);

    // Secret token 驗證
    if (!verifyTelegramSecretToken(req)) {
      console.warn("Invalid x-telegram-bot-api-secret-token");
      return res.status(401).send("Unauthorized");
    }

    console.log(
      "TELEGRAM_WEBHOOK_PAYLOAD:",
      JSON.stringify(req.body, null, 2)
    );

    const msg = req.body?.message || req.body?.edited_message;
    chatId = msg?.chat?.id;
    const messageText = msg?.text;

    if (!chatId) {
      console.log("No chatId. Just ACK.");
      return res.status(200).send("OK");
    }

    if (!messageText || !messageText.trim()) {
      console.log("No text message found. Skipping AI.");
      await replyToTelegram({
        chatId,
        text: "我目前只處理純文字訊息喔～可以直接貼一段文字給我整理。",
      });
      return res.status(200).send("OK");
    }

    console.log("Sending to Gemini (SDK):", messageText);

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: messageText }] }],
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
        text: "抱歉，我拿到的 AI 回覆不是有效的 JSON，請再試一次或換一段文字。",
      });
      return res.status(200).send("OK");
    }

    console.log("GEMINI_RESPONSE_JSON:", parsed);

    // ====== 寫入 Supabase ======
    if (supabase) {
      try {
        const from = msg?.from || {};

        const { error: dbError } = await supabase
          .from("notes") // 如果你的表名不是 notes，這裡改掉
          .insert({
            tg_chat_id: chatId,
            tg_user_id: from.id ?? null,
            title: parsed.title ?? null,
            summary: parsed.summary ?? null,
            tags: parsed.tags ?? null,   // jsonb 欄位
            raw_text: messageText,
            created_at: new Date().toISOString(),
          });

        if (dbError) {
          console.error("Supabase insert error:", dbError);
        } else {
          console.log("Supabase insert success");
        }
      } catch (e) {
        console.error("Supabase insert exception:", e);
      }
    } else {
      console.warn("Supabase not initialized, skip insert.");
    }

    // ====== 回覆 Telegram ======
    const pretty = [
      `🧠 <b>AI 摘要完成</b>`,
      `\n<b>標題</b>：${parsed.title ?? ""}`,
      `\n<b>摘要</b>：${parsed.summary ?? ""}`,
      `\n<b>標籤</b>：${
        Array.isArray(parsed.tags) ? parsed.tags.join(", ") : ""
      }`,
    ].join("");

    await replyToTelegram({ chatId, text: pretty });

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing webhook:", error);

    if (chatId) {
      await replyToTelegram({
        chatId,
        text: "呼叫 AI 服務發生錯誤，已紀錄詳情。",
      });
    }
    // 為了避免 Telegram 一直重送，這裡還是回 200
    return res.status(200).send("OK");
  }
}


