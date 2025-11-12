import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  systemInstruction:
`你是一位資料歸檔專家。請分析以下內容。
請產生一個只包含三個欄位的 JSON 物件：
1. "title"：簡短吸引人的標題
2. "summary"：不超過 100 字的精簡摘要
3. "tags"：包含 5 個最相關關鍵字的陣列

範例輸出：
{
  "title": "標題",
  "summary": "摘要...",
  "tags": ["標籤1", "標籤2", "標籤3", "標籤4", "標籤5"]
}

請只回傳上述 JSON，且不要包含 Markdown 或程式碼框的任何標記。`
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    console.log("TELEGRAM_WEBHOOK_PAYLOAD:", JSON.stringify(req.body, null, 2));
    const messageText = req.body?.message?.text;
    if (!messageText) return res.status(200).send("OK. No text.");

    console.log("Sending to Gemini:", messageText);

    const chat = model.startChat({
      generationConfig: { responseMimeType: "application/json" }
    });

    const result = await chat.sendMessage(messageText);
    const aiResponse = result.response.text();

    console.log("GEMINI_RESPONSE_JSON:", aiResponse);
    return res.status(200).send("OK. AI Processed.");
  } catch (e) {
    console.error("Error processing webhook:", e);
    return res.status(500).send("Internal Server Error");
  }
}
