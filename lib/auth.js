// 單一密碼登入：APP_PASSWORD 存在 Vercel 環境變數
// 登入成功後發一個 HMAC 簽章的 cookie（HttpOnly），有效 90 天
// 換密碼 = 所有舊 cookie 自動失效（除非另外設定 SESSION_SECRET）
import crypto from "node:crypto";

export const COOKIE_NAME = "mm_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 90;

function secret() {
  const s = process.env.SESSION_SECRET || process.env.APP_PASSWORD;
  return s ? `mymind:${s}` : null;
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function isConfigured() {
  return Boolean(process.env.APP_PASSWORD);
}

export function checkPassword(input) {
  if (!isConfigured() || typeof input !== "string") return false;
  return safeEqual(input, process.env.APP_PASSWORD);
}

export function issueSessionCookie() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_SEC);
  const token = `${exp}.${sign(exp)}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SEC}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(req, name) {
  const raw = req.headers?.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function isAuthed(req) {
  if (!secret()) return false;
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (!safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now() / 1000;
}

// 在 API handler 開頭呼叫：未登入就回 401 並回傳 false
export function requireAuth(req, res) {
  if (!isConfigured()) {
    res.status(500).json({ error: "尚未設定 APP_PASSWORD 環境變數" });
    return false;
  }
  if (!isAuthed(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}
