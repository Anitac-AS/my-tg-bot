// 檔案: api/webhook.js

// 匯入 Google AI SDK
import { GoogleGenerativeAI } from "@google/generative-ai";

// 1. 初始化 AI 模型
// Vercel 會自動從「環境變數」讀取 process.env.GEMINI_API_KEY
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 這是 AI 的主要指令 (Prompt)
const systemPrompt = `
你是一位資料歸檔專家。請分析以下內容。
你的任務是精準地產生一個 JSON 物件，包含三個欄位：
1.  "title": 一個簡短、吸引人的標題。
2.  "summary": 一段不超過 100 字的精簡摘要。
3.  "tags": 一個包含 5 個最相關關鍵字的 JavaScript 陣列 (Array)。

範例輸出：
{
  "title": "標題",
  "summary": "摘要...",
  "tags": ["標籤1", "標籤2", "標籤3", "標籤4", "標籤5"]
}

請只回傳這個 JSON 物件，不要有任何 "json" 或 "```" 的標記。
`;

// 主處理函式
export default async function handler(request, response) {
  
  try {
    // --- 1. 從 Telegram 取得訊息 ---
    console.log("TELEGRAM_WEBHOOK_PAYLOAD:", JSON.stringify(request.body, null, 2));
    
    // 從 Telegram 的 JSON 中，只抓出「使用者傳送的文字」
    // (這會忽略貼圖、編輯訊息、群組訊息等)
    const messageText = request.body?.message?.text;

    // 如果沒有收到文字 (例如傳了貼圖)，就直接回覆 OK
    if (!messageText) {
      console.log("No text message found. Skipping AI.");
      return response.status(200).send("OK. No text.");
    }

    // --- 2. 呼叫 Gemini AI ---
    console.log("Sending to Gemini:", messageText);
    
    const chat = model.startChat({
      generationConfig: {
        responseMimeType: "application/json", // [重要] 強迫 AI 回傳 JSON
      },
      systemInstruction: systemPrompt,
    });

    const result = await chat.sendMessage(messageText);
    const aiResponse = result.response.text();

    // --- 3. 輸出 AI 結果 (目前先印出來) ---
    console.log("GEMINI_RESPONSE_JSON:", aiResponse);
    
    // (下一步：我們將在這裡把 aiResponse 存入 Supabase 資料庫)

    // --- 4. 回覆 Telegram ---
    // 必須立刻回覆 200 OK，讓 Telegram 知道收到了
    response.status(200).send("OK. AI Processed.");

  } catch (error) {
    console.error("Error processing webhook:", error);
    response.status(500).send("Internal Server Error");
  }
}
