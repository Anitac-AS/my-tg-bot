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
   ["教育","親子","AI","資訊","健康","旅遊","趣味","購物","興趣"]

2. 若內容真的無法匹配上述分類，才允許新增新的標籤，但請控制在 1~2 個。

3. 標籤盡量使用單詞或短片語，避免出現完整句子。
請只輸出「純 JSON」，不要有 Markdown、說明文字或 \\\` 區塊。
`;

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

// ====== Helper: 回覆 Telegram ======
async function replyToTelegram({ chatId, text }) {
  if (!process.env.BOT_TOKEN) return;
  const url = https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage;
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

// ====== Helper: 處理圖片上傳 (新增功能) ======
async function handlePhotoUpload(fileId) {
  try {
    const token = process.env.BOT_TOKEN;
    
    // 1. 取得檔案路徑 (getFile)
    const fileInfoRes = await fetch(https://api.telegram.org/bot${token}/getFile?file_id=${fileId});
    const fileInfo = await fileInfoRes.json();
    
    if (!fileInfo.ok || !fileInfo.result.file_path) {
      throw new Error("Cannot get file path from Telegram");
    }

    const filePath = fileInfo.result.file_path;
    const downloadUrl = https://api.telegram.org/file/bot${token}/${filePath};

    // 2. 下載檔案
    const imgRes = await fetch(downloadUrl);
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 3. 上傳到 Supabase Storage
    // 檔名加上 timestamp 避免重複： photos/1709234123_abcde.jpg
    const ext = filePath.split('.').pop(); // 取得副檔名 (jpg/png)
    const fileName = photos/${Date.now()}_${fileId}.${ext};

    const { data, error } = await supabase.storage
      .from('assets') // 請確認 Bucket 名稱是 'assets'
      .upload(fileName, buffer, {
        contentType: image/${ext},
        upsert: false
      });

    if (error) throw error;

    // 4. 取得公開網址
    const { data: publicData } = supabase.storage
      .from('assets')
      .getPublicUrl(fileName);

    return publicData.publicUrl;

  } catch (err) {
    console.error("Image upload failed:", err);
    return null; // 上傳失敗回傳 null，但不中斷流程
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

    chatId = msg.chat.id;

    // === 修改點 1: 判斷輸入來源 (純文字 或 圖片+圖說) ===
    let messageText = "";
    let attachments = []; // 準備存入 DB 的附件欄位

    // 情境 A: 純文字
    if (msg.text) {
      messageText = msg.text;
    } 
    // 情境 B: 圖片 (Photo)
    else if (msg.photo) {
      // 圖片通常是一個 array，最後一張解析度最高
      const bestPhoto = msg.photo[msg.photo.length - 1];
      
      // 嘗試上傳圖片
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

      // 取得圖說 (Caption) 作為 AI 分析的文字
      messageText = msg.caption || ""; 
    }

    // 若完全沒有文字 (純圖無圖說 或 不支援的格式)
    if (!messageText.trim()) {
      if (attachments.length > 0) {
        // 有圖但沒字 -> 還是存進去，但 title/summary 可能需要預設值
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
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" },
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: messageText }] }],
    });

    let parsed;
    try {
      parsed = JSON.parse(result.response.text());
    } catch (e) {
      console.error("AI JSON Parse Error");
      // 若 JSON 解析失敗，還是將資料存入，避免丟失
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
          raw_text: messageText,      // 存入的文字 (若是圖片則是 caption)
          attachments: attachments,   // === 修改點 2: 存入 attachments JSONB ===
          created_at: new Date().toISOString(),
        });

      if (dbError) console.error("DB Insert Error:", dbError);
    }

    // ====== 回覆 Telegram ======
    // 若有圖片，可以在回覆中加個標記 ✅
    const hasImg = attachments.length > 0 ? " [包含圖片]" : "";
    
    const pretty = [
      🧠 <b>AI 歸檔完成${hasImg}</b>,
      \n<b>標題</b>：${parsed.title ?? ""},
      \n<b>摘要</b>：${parsed.summary ?? ""},
      \n<b>標籤</b>：${Array.isArray(parsed.tags) ? parsed.tags.join(", ") : ""},
    ].join("");

    await replyToTelegram({ chatId, text: pretty });

    return res.status(200).send("OK");

  } catch (error) {
    console.error("Handler Error:", error);
    if (chatId) await replyToTelegram({ chatId, text: "系統發生錯誤，請稍後再試。" });
    return res.status(200).send("OK");
  }
}
