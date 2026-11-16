// 檔案：api/notes.js
// GET    ?q=關鍵字（空白分隔＝AND）&tags=a,b（AND）&type=image|link|text&limit=30&offset=0
//        → { data: [...], total }
// PATCH  ?id=123  body: { title?, summary?, tags?, pinned? }  → { data: row }
// DELETE ?id=123  → { ok: true }（連同 Storage 裡的圖片一起刪）
import { supabase, STORAGE_BUCKET } from "../lib/supabase.js";
import { requireAuth } from "../lib/auth.js";
import { isEmbeddingConfigured, embedText, noteText, toPgVector } from "../lib/embedding.js";

const TYPES = new Set(["", "image", "link", "text"]);

function getParams(req) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  return url.searchParams;
}

function cleanTags(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const t of input) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/^#/, "").slice(0, 30);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 10);
}

async function handleGet(req, res) {
  const p = getParams(req);
  const q = (p.get("q") || "").trim().slice(0, 200);
  const tagsParam = p.get("tags") || p.get("tag") || "";
  const tags = tagsParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 10);
  const type = TYPES.has(p.get("type") || "") ? (p.get("type") || "") : "";
  const limit = Math.min(Math.max(parseInt(p.get("limit") || "30", 10) || 30, 1), 100);
  const offset = Math.max(parseInt(p.get("offset") || "0", 10) || 0, 0);

  // 有關鍵字時：語意＋關鍵字混合搜尋；向量服務失敗就退回純關鍵字
  if (q && isEmbeddingConfigured()) {
    try {
      const vec = await embedText(q, "RETRIEVAL_QUERY");
      const { data, error } = await supabase.rpc("mm_hybrid_search", {
        p_q: q, p_embedding: toPgVector(vec), p_tags: tags, p_type: type, p_limit: limit, p_offset: offset,
        p_min_similarity: Number(process.env.SEMANTIC_MIN_SIMILARITY) || 0.6,
      });
      if (error) throw error;
      return res.status(200).json({ data: data?.data || [], total: data?.total ?? 0, mode: "hybrid" });
    } catch (err) {
      console.error("Hybrid search failed, falling back to keyword:", err.message || err);
    }
  }

  const { data, error } = await supabase.rpc("mm_search_notes", {
    p_q: q, p_tags: tags, p_type: type, p_limit: limit, p_offset: offset,
  });
  if (error) {
    console.error("Search error:", error);
    return res.status(500).json({ error: "Supabase query error" });
  }
  return res.status(200).json({ data: data?.data || [], total: data?.total ?? 0 });
}

async function handlePatch(req, res, id) {
  const body = req.body || {};
  const patch = {};
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200);
  if (typeof body.summary === "string") patch.summary = body.summary.trim().slice(0, 2000);
  if (body.tags !== undefined) {
    const tags = cleanTags(body.tags);
    if (!tags) return res.status(400).json({ error: "tags 必須是陣列" });
    patch.tags = tags;
  }
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (!Object.keys(patch).length) return res.status(400).json({ error: "沒有可更新的欄位" });

  const { data, error } = await supabase
    .from("notes").update(patch).eq("id", id).select().single();
  if (error) {
    console.error("Update error:", error);
    return res.status(500).json({ error: "更新失敗" });
  }

  // 內容有變就重算向量（失敗不影響這次更新）
  if ((patch.title !== undefined || patch.summary !== undefined || patch.tags !== undefined) && isEmbeddingConfigured()) {
    try {
      const vec = await embedText(noteText(data), "RETRIEVAL_DOCUMENT");
      const { error: embErr } = await supabase.from("notes").update({ embedding: toPgVector(vec) }).eq("id", id);
      if (embErr) throw embErr;
    } catch (err) {
      console.error("Re-embed failed:", err.message || err);
    }
  }

  if (data) delete data.embedding;
  return res.status(200).json({ data });
}

function storagePathFromUrl(url) {
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const idx = typeof url === "string" ? url.indexOf(marker) : -1;
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length).split("?")[0]);
}

async function handleDelete(req, res, id) {
  const { data: row, error: getErr } = await supabase
    .from("notes").select("attachments").eq("id", id).single();
  if (getErr) {
    console.error("Fetch before delete error:", getErr);
    return res.status(404).json({ error: "找不到這筆記錄" });
  }

  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) {
    console.error("Delete error:", error);
    return res.status(500).json({ error: "刪除失敗" });
  }

  const paths = (Array.isArray(row?.attachments) ? row.attachments : [])
    .map(a => storagePathFromUrl(a?.url)).filter(Boolean);
  if (paths.length) {
    const { error: stErr } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
    if (stErr) console.error("Storage cleanup error:", stErr); // 不影響結果
  }
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAuth(req, res)) return;
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  try {
    if (req.method === "GET") return await handleGet(req, res);

    const id = getParams(req).get("id");
    if (!id) return res.status(400).json({ error: "缺少 id" });
    if (req.method === "PATCH") return await handlePatch(req, res, id);
    if (req.method === "DELETE") return await handleDelete(req, res, id);

    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (err) {
    console.error("Notes API error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
