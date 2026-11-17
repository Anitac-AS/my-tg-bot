// 檔案：api/summarize.js
// POST { q, ids: [...] }（最多 10 則，依搜尋結果順序）
// → { intro, points: [{ text, refs: [1,2] }], excluded, ids }
// refs 是 ids 陣列中的序號（從 1 開始）
import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";

const MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const MAX_NOTES = 10;
const MAX_RAW = 1500;

const SYSTEM = `
你是使用者個人知識庫的整理助理。使用者剛搜尋了一個關鍵字，下面是搜尋到的筆記（每則有編號）。
請只根據這些筆記內容，用繁體中文幫使用者整理重點。

規則：
1. 只能使用筆記裡的資訊，不可以補充筆記沒寫的事實、不可以臆測。
2. 每個重點後面標註依據的筆記編號（refs）。
3. 與搜尋主題關係不大的筆記不要硬塞，放到 excluded 簡短說明（例如「第 5、6 則是行程與住宿，與購物無關」）；全部都相關就給空字串。
4. 語氣自然、精簡，像朋友幫你快速翻過筆記。intro 一句話總結；points 最多 6 點，每點一句。

只輸出 JSON：
{"intro": "一句話總結", "points": [{"text": "重點", "refs": [1, 2]}], "excluded": "或空字串"}
`;

function noteBlock(row, i) {
  const tags = Array.isArray(row.tags) ? row.tags.join("、") : "";
  const date = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : "";
  return [
    `【${i + 1}】${row.title || "無標題"}（${date}${tags ? `；標籤：${tags}` : ""}）`,
    row.summary ? `摘要：${row.summary}` : "",
    row.raw_text ? `原文：${String(row.raw_text).slice(0, MAX_RAW)}` : "",
  ].filter(Boolean).join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY" });

  const q = String(req.body?.q || "").trim().slice(0, 200);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, MAX_NOTES);
  if (!ids.length) return res.status(400).json({ error: "沒有可整理的筆記" });

  try {
    const { data: rows, error } = await supabase
      .from("notes").select("id, title, summary, tags, raw_text, created_at").in("id", ids);
    if (error) throw error;
    const byId = new Map((rows || []).map(r => [String(r.id), r]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean);
    if (!ordered.length) return res.status(404).json({ error: "找不到這些筆記" });

    const prompt = [
      q ? `使用者搜尋：「${q}」` : "使用者在篩選後瀏覽以下筆記。",
      "",
      ordered.map(noteBlock).join("\n\n"),
    ].join("\n");

    const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
      model: MODEL,
      systemInstruction: SYSTEM,
      generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
    });
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());

    const n = ordered.length;
    const points = (Array.isArray(parsed.points) ? parsed.points : []).slice(0, 6).map(p => ({
      text: String(p?.text || "").slice(0, 300),
      refs: [...new Set((Array.isArray(p?.refs) ? p.refs : []).map(Number).filter(x => Number.isInteger(x) && x >= 1 && x <= n))],
    })).filter(p => p.text);

    return res.status(200).json({
      intro: String(parsed.intro || "").slice(0, 300),
      points,
      excluded: String(parsed.excluded || "").slice(0, 300),
      ids: ordered.map(r => r.id),
    });
  } catch (err) {
    console.error("Summarize error:", err);
    return res.status(500).json({ error: "AI 整理失敗，請稍後再試" });
  }
}
