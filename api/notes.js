// 檔案：api/notes.js
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Server 端用 service_role，這個檔案只在 Vercel function 上執行，不會外洩
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    console.error("Supabase client not initialized");
    return res.status(500).json({ error: "Supabase not configured" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // 解析 ?q= 關鍵字 & ?tag= 標籤
    const url = new URL(req.url, `https://${req.headers.host}`);
    const q   = url.searchParams.get("q")?.trim()   || "";
    const tag = url.searchParams.get("tag")?.trim() || "";

    let query = supabase
      .from("notes") // 如果你的表不是叫 notes，這裡改掉
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    // 用 ilike 搜尋 title / summary / raw_text
    if (q) {
      const pattern = `%${q}%`;
      query = query.or(
        `title.ilike.${pattern},summary.ilike.${pattern},raw_text.ilike.${pattern}`
      );
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase query error:", error);
      return res.status(500).json({ error: "Supabase query error" });
    }

    // 👉 在程式裡用 tags 做第二層過濾（真正的「標籤搜尋」）
    let result = data || [];
    if (tag) {
      result = result.filter(row =>
        Array.isArray(row.tags) && row.tags.includes(tag)
      );
    }

    return res.status(200).json({ data: result });
  } catch (err) {
    console.error("Notes API error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
