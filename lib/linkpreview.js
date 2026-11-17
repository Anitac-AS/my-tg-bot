// 連結預覽：抓網頁的標題、描述、縮圖（Open Graph / meta / <title>）
// 只存文字與圖片網址（不另存圖片），每則不到 1KB
const URL_RE = /https?:\/\/[^\s<>"'）)】」]+/i;
const TIMEOUT_MS = 6000;
const MAX_BYTES = 600_000;

export function firstUrl(text) {
  const m = String(text || "").match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:!?。，、！？]+$/, "");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function metaContent(html, keys) {
  for (const key of keys) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decodeEntities(m[1]);
  }
  return "";
}

async function readLimited(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  try { reader.cancel(); } catch {}
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
}

// 成功回傳 { type: "link", url, title, description, image, site }；失敗回傳 null
export async function fetchLinkPreview(url) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ShuPocketBot/1.0; +link-preview)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok || !/text\/html|application\/xhtml/i.test(res.headers.get("content-type") || "")) return null;
    const html = await readLimited(res);
    const finalUrl = res.url || url;

    const title = metaContent(html, ["og:title", "twitter:title"])
      || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const description = metaContent(html, ["og:description", "twitter:description", "description"]);
    let image = metaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
    const site = metaContent(html, ["og:site_name"]) || new URL(finalUrl).hostname.replace(/^www\./, "");
    if (image) { try { image = new URL(image, finalUrl).href; } catch { image = ""; } }
    if (image && !/^https:\/\//i.test(image)) image = ""; // 網站是 https，只收 https 圖片

    if (!title && !description && !image) return null;
    return {
      type: "link",
      url,
      title: title.slice(0, 200),
      description: description.slice(0, 400),
      image: image.slice(0, 1000),
      site: site.slice(0, 100),
    };
  } catch (e) {
    console.warn("Link preview failed:", url, e.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 給 Gemini 參考的補充文字（讓「只有網址」的訊息也能有好摘要）
export function previewContext(p) {
  if (!p) return "";
  return [`\n\n（連結網頁資訊，僅供摘要參考）`,
    p.title ? `網頁標題：${p.title}` : "",
    p.description ? `網頁描述：${p.description}` : "",
    p.site ? `網站：${p.site}` : ""].filter(Boolean).join("\n");
}
