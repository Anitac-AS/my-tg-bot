// 檔案：api/reindex.js
// 替還沒有向量的筆記補建語意索引
// GET  → { remaining, configured }
// POST → 處理一批（最多 20 則）→ { done, failed, remaining }
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { isEmbeddingConfigured, embedBatch, noteText, toPgVector } from "../lib/embedding.js";

const BATCH = 20;

async function countRemaining() {
  const { count, error } = await supabase
    .from("notes").select("id", { count: "exact", head: true }).is("embedding", null);
  if (error) throw error;
  return count || 0;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  try {
    if (req.method === "GET") {
      return res.status(200).json({ remaining: await countRemaining(), configured: isEmbeddingConfigured() });
    }

    if (req.method === "POST") {
      if (!isEmbeddingConfigured()) return res.status(500).json({ error: "尚未設定 GEMINI_API_KEY" });

      const { data: rows, error } = await supabase
        .from("notes").select("id, title, summary, tags, raw_text, attachments")
        .is("embedding", null).order("created_at", { ascending: false }).limit(BATCH);
      if (error) throw error;

      let done = 0, failed = 0;
      if (rows?.length) {
        const vectors = await embedBatch(rows.map(noteText), "RETRIEVAL_DOCUMENT");
        for (let i = 0; i < rows.length; i++) {
          const { error: upErr } = await supabase
            .from("notes").update({ embedding: toPgVector(vectors[i]) }).eq("id", rows[i].id);
          if (upErr) { failed++; console.error("Reindex update error:", upErr); } else done++;
        }
      }
      return res.status(200).json({ done, failed, remaining: await countRemaining() });
    }

    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (err) {
    console.error("Reindex error:", err);
    return res.status(500).json({ error: err.message || "建立索引失敗" });
  }
}
