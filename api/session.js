// 檔案：api/session.js
// GET    → { authed: boolean }
// POST   → 登入，body: { password }
// DELETE → 登出
import {
  isConfigured, isAuthed, checkPassword,
  issueSessionCookie, clearSessionCookie,
} from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({ authed: isAuthed(req), configured: isConfigured() });
  }

  if (req.method === "POST") {
    if (!isConfigured()) {
      return res.status(500).json({ error: "尚未設定 APP_PASSWORD 環境變數" });
    }
    const password = req.body?.password;
    if (!checkPassword(password)) {
      // 簡單拖慢暴力嘗試
      await new Promise(r => setTimeout(r, 800));
      return res.status(401).json({ error: "密碼錯誤" });
    }
    res.setHeader("Set-Cookie", issueSessionCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method Not Allowed" });
}
