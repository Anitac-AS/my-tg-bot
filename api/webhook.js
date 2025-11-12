// 檔案：api/webhook.js
import { GoogleGenerativeAI } from "@google/generative-ai";

// 初始化 Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest",
  systemInstruction: `
你是一位資料歸檔專家，請分析以下內容，產生一個 JSON 物件：
{
  "title": "一句簡短吸引人的標題",
  "summary": "一段不超過 100 字的摘要",
  "tags": ["標籤1","標籤2","標籤3","標籤4","標籤5"]
}
請只輸出純 JSON，勿包含 Markdown 或其他文字。`
});

// Webhook 處理函式
export default async function handler(req, res) {
  try {
    // 僅允許 POST
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    console.log("TELEGRAM_WEBHOOK_PAYLOAD:", JSON.stringify(req.body, null, 2));

    const messageText = req.body?.message?.text;
    if (!messageText) {
      console.log("No text message found. Skipping AI.");
      return res.status(200).send("OK. No text.");
    }

    console.log("Sending to Gemini:", messageText);

    // 呼叫 Gemini 產生結果
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: messageText }] }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const text = result.response.text();
    console.log("GEMINI_RESPONSE_RAW:", text);

    // 嘗試解析 JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.error("AI response is not valid JSON:", text);
      return res.status(502).send("Invalid AI Response");
    }

    console.log("GEMINI_RESPONSE_JSON:", parsed);

    // （後續可以在這裡把 parsed 存進 Supabase）

    return res.status(200).send("OK. AI Processed.");
  } catch (error) {
    console.error("Error processing webhook:", error);
    return res.status(500).send("Internal Server Error");
  }
}
