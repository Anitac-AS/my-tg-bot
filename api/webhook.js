// 檔案：api/webhook.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import { isEmbeddingConfigured, embedText, noteText, toPgVector } from "../lib/embedding.js";

// ====== Gemini 設定 ======
const MODEL_NAME = "gemini-2.5-flash";

const CORE_TAGS = ["教育","親子","AI","資訊","健康","旅遊","趣味","購物","興趣"];

// 依照資料庫現有標籤組出提示，讓 AI 優先沿用，避免標籤越長越多
function buildSystemPrompt(existingTags) {
  const extra = existingTags.filter(t => !CORE_TAGS.includes(t));
  return `
你是一位資料歸檔專家。請分析以下內容，產生一個 JSON 物件，包含：

{
  "title": "一句簡短吸引人的標題",
  "summary": "一段不超過 100 字的摘要",
  "tags": ["標籤1","標籤2","標籤3"]
}
標籤規則（非常重要，請嚴格遵守）：
1. 總共給 1~4 個標籤，寧缺勿濫。
2. 第一優先：從核心分類選 1~3 個：${JSON.stringify(CORE_TAGS)}
3. 第二優先：知識庫已經在用的其他標籤：${JSON.stringify(extra)}
   只要意思相近就沿用，不要另造同義詞（例如已有「食譜」就不要新增「料理」「美食」）。
4. 只有在以上都完全不適用時，才可新增 1 個新標籤；新標籤必須是 2~4 個字的通用名詞，不可以是專有名詞、人名、品牌或句子。
請只輸出「純 JSON」，不要有 Markdown、說明文字或 \`\`\` 區塊。
`;
}

// 取得常用標籤（最多 40 個）；失敗時退回只用核心分類
async function getExistingTags() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("mm_tag_counts");
    if (error) throw error;
    return (data || []).filter(r => Number(r.cnt) >= 2).slice(0, 40).map(r => r.tag);
  } catch (e) {
    console.error("Load tags failed:", e);
    return [];
  }
}

function normalizeTags(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/^#/, "").slice(0, 30);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 4);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ====== Supabase 設定 ======
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (!supabase) {
  console.error("Supabase client not initialized.");
}

// ====== Telegram 驗證 ======
function verifyTelegramSecretToken(req) {
  const expected = process.env.TG_SECRET_TOKEN;
  if (!expected) return true;
  const got = req.headers["x-telegram-bot-api-secret-token"];
  return typeof got === "string" && got === expected;
}

// ====== 語意索引（失敗不影響存檔，之後可在網頁補建）======
async function makeEmbedding(row) {
  if (!isEmbeddingConfigured()) return null;
  try {
    return toPgVector(await embedText(noteText(row), "RETRIEVAL_DOCUMENT"));
  } catch (e) {
    console.error("Embedding failed:", e.message || e);
    return null;
  }
}

// ====== 使用者白名單（ALLOWED_TG_USER_IDS，逗號分隔；未設定則不限制）======
function isAllowedUser(msg) {
  const list = (process.env.ALLOWED_TG_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.includes(String(msg.from?.id ?? ""));
}

// ====== Helper: 回覆 Telegram ======
async function replyToTelegram({ chatId, text }) {
  if (!process.env.BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("Reply error:", e);
  }
}

// ====== Helper: 處理圖片上傳 ======
async function handlePhotoUpload(fileId) {
  try {
    const token = process.env.BOT_TOKEN;

    const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();

    if (!fileInfo.ok || !fileInfo.result.file_path) {
      throw new Error("Cannot get file path from Telegram");
    }

    const filePath = fileInfo.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    const imgRes = await fetch(downloadUrl);
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const ext = filePath.split('.').pop();
    const fileName = `photos/${Date.now()}_${fileId}.${ext}`;

    const { data, error } = await supabase.storage
      .from('assets')
      .upload(fileName, buffer, {
        contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
        upsert: false
      });

    if (error) throw error;

    const { data: publicData } = supabase.storage
      .from('assets')
      .getPublicUrl(fileName);

    return publicData.publicUrl;

  } catch (err) {
    console.error("Image upload failed:", err);
    return null;
  }
}

// ====== Webhook 主處理器 ======
export default async function handler(req, res) {
  let chatId;

  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    if (!verifyTelegramSecretToken(req)) return res.status(401).send("Unauthorized");

    const msg = req.body?.message || req.body?.edited_message;
    if (!msg) return res.status(200).send("OK");

    if (!isAllowedUser(msg)) {
      console.warn("Blocked user:", msg.from?.id);
      return res.status(200).send("OK");
    }

    chatId = msg.chat.id;

    let messageText = "";
    let attachments = [];

    if (msg.text) {
      messageText = msg.text;
    } else if (msg.photo) {
      const bestPhoto = msg.photo[msg.photo.length - 1];

      console.log("Processing photo...");
      const publicUrl = await handlePhotoUpload(bestPhoto.file_id);

      if (publicUrl) {
        attachments.push({
          type: "image",
          url: publicUrl,
          width: bestPhoto.width,
          height: bestPhoto.height
        });
      }

      messageText = msg.caption || "";
    }

    if (!messageText.trim()) {
      if (attachments.length > 0) {
        messageText = "(這張圖片沒有附帶說明)";
      } else {
        await replyToTelegram({ chatId, text: "我需要文字或帶有文字說明的圖片喔！" });
        return res.status(200).send("OK");
      }
    }

    // ====== AI 分析 ======
    console.log("Analyze:", messageText);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: buildSystemPrompt(await getExistingTags()),
      generationConfig: { responseMimeType: "application/json" },
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: messageText }] }],
    });

    let parsed;
    try {
      parsed = JSON.parse(result.response.text());
      parsed.tags = normalizeTags(parsed.tags);
    } catch (e) {
      console.error("AI JSON Parse Error");
      parsed = { title: "AI 解析失敗", summary: messageText, tags: [] };
    }

    // ====== 寫入 Supabase ======
    if (supabase) {
      const { error: dbError } = await supabase
        .from("notes")
        .insert({
          tg_chat_id: chatId,
          tg_user_id: msg.from?.id ?? null,
          title: parsed.title,
          summary: parsed.summary,
          tags: parsed.tags,
          raw_text: messageText,
          attachments: attachments,
          created_at: new Date().toISOString(),
          embedding: await makeEmbedding({ ...parsed, raw_text: messageText }),
        });

      if (dbError) console.error("DB Insert Error:", dbError);
    }

    // ====== 回覆 Telegram ======
    const hasImg = attachments.length > 0 ? " [包含圖片]" : "";

    const pretty = [
      `🧠 <b>AI 歸檔完成${hasImg}</b>`,
      `\n<b>標題</b>：${parsed.title ?? ""}`,
      `\n<b>摘要</b>：${parsed.summary ?? ""}`,
      `\n<b>標籤</b>：${Array.isArray(parsed.tags) ? parsed.tags.join(", ") : ""}`,
    ].join("");

    await replyToTelegram({ chatId, text: pretty });

    return res.status(200).send("OK");

  } catch (error) {
    console.error("Handler Error:", error);
    if (chatId) await replyToTelegram({ chatId, text: "系統發生錯誤，請找原因。" });
    return res.status(200).send("OK");
  }
}
