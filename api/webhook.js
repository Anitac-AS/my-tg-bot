// 檔案: api/webhook.js

export default function handler(request, response) {
  try {
    // 1. 將 Telegram 傳來的整個 request body 印出來
    // (JSON.stringify(..., null, 2) 是為了讓 log 格式化，更易讀)
    console.log("TELEGRAM_WEBHOOK_PAYLOAD:", JSON.stringify(request.body, null, 2));

    // 2. 收到訊息後，你可以在這裡觸發「非同步」的 AI 分析
    // (例如：呼叫 Gemini API、存資料庫等... 這是我們下一步要做的事)

    // 3. [重要] 立即回傳 200 OK 給 Telegram
    // 必須在幾秒內回傳，否則 Telegram 會以為失敗並重試。
    response.status(200).send("OK. Message received.");

  } catch (error) {
    // 處理例外錯誤
    console.error("Error processing webhook:", error);
    response.status(500).send("Internal Server Error");
  }
}