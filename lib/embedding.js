// 文字向量（Gemini embedding）
// 筆記存入、編輯時產生 RETRIEVAL_DOCUMENT 向量；搜尋時產生 RETRIEVAL_QUERY 向量
const MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const DIM = 768;
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_CHARS = 6000;

export const EMBEDDING_DIM = DIM;

export function isEmbeddingConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// 筆記轉成要做向量的文字
export function noteText(row) {
  const tags = Array.isArray(row?.tags) ? row.tags.join("、") : "";
  const link = (Array.isArray(row?.attachments) ? row.attachments : []).find(a => a?.type === "link");
  return [
    row?.title ? `標題：${row.title}` : "",
    tags ? `標籤：${tags}` : "",
    row?.summary ? `摘要：${row.summary}` : "",
    row?.raw_text ? `內容：${row.raw_text}` : "",
    link?.title ? `連結標題：${link.title}` : "",
    link?.description ? `連結描述：${link.description}` : "",
  ].filter(Boolean).join("\n").slice(0, MAX_CHARS);
}

function toVector(values) {
  if (!Array.isArray(values) || values.length < DIM) throw new Error("Embedding 維度不足");
  // gemini-embedding-001 為 Matryoshka 向量，截斷前 768 維即可（相似度用 cosine，不需重新正規化）
  return values.slice(0, DIM);
}

function request(text, taskType) {
  return {
    model: `models/${MODEL}`,
    content: { parts: [{ text: text.slice(0, MAX_CHARS) || " " }] },
    taskType,
    outputDimensionality: DIM,
  };
}

async function call(path, body) {
  const res = await fetch(`${BASE}/models/${MODEL}:${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${json?.error?.message || "unknown error"}`);
  return json;
}

export async function embedText(text, taskType = "RETRIEVAL_DOCUMENT") {
  const { model, ...rest } = request(text, taskType);
  const json = await call("embedContent", rest);
  return toVector(json?.embedding?.values);
}

export async function embedBatch(texts, taskType = "RETRIEVAL_DOCUMENT") {
  if (!texts.length) return [];
  const json = await call("batchEmbedContents", { requests: texts.map(t => request(t, taskType)) });
  const list = json?.embeddings || [];
  if (list.length !== texts.length) throw new Error("Embedding 回傳數量不符");
  return list.map(e => toVector(e?.values));
}

// pgvector 接受 "[0.1,0.2,...]" 字串
export function toPgVector(vec) {
  return vec ? `[${vec.join(",")}]` : null;
}
