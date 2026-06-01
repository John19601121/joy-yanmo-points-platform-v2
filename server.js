const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || "data/app.sqlite");
const SCHEMA_PATH = path.join(ROOT, "schema.sql");
const PUBLIC_DIR = path.join(ROOT, "public");
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-change-me-joy-yanmo";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";

if (process.env.NODE_ENV === "production" && SESSION_SECRET === "dev-change-me-joy-yanmo") {
  throw new Error("Production requires SESSION_SECRET.");
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

const zhType = { purchase: "購買點數", gift: "贈予點數", consume: "消費扣點" };
const zhStatus = { completed: "已完成", pending: "待核准", rejected: "已拒絕", approved: "已核准" };

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [method, iterText, salt, hash] = String(stored || "").split("$");
  if (method !== "pbkdf2" || !iterText || !salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, Number(iterText), 32, "sha256").toString("base64url");
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    role: user.role,
    store_id: user.store_id,
    name: user.name,
    exp: Date.now() + 1000 * 60 * 60 * 8
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function parseToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (sign(payload) !== sig) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data.exp || data.exp < Date.now()) return null;
  return db.prepare("SELECT id, role, name, email, phone, store_id FROM users WHERE id = ?").get(data.id) || null;
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function money(n) {
  return Number(n || 0).toLocaleString("zh-TW");
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function loginPathForRole(role) {
  return role === "admin" ? "/admin/login" : role === "store" ? "/store/login" : "/member/login";
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function isUniqueConstraintError(error) {
  return String(error?.message || "").includes("UNIQUE constraint failed");
}

function duplicateEmailMessage() {
  return "此 Email 已被使用，請更換 Email。";
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}

function currentUser(req) {
  return parseToken(parseCookies(req.headers.cookie).session);
}

function requireUser(req, res, roles) {
  const user = currentUser(req);
  if (!user) {
    redirect(res, roles?.[0] === "admin" ? "/admin/login" : roles?.[0] === "member" ? "/member/login" : "/store/login");
    return null;
  }
  if (roles && !roles.includes(user.role)) {
    send(res, 403, page("無權限", `<div class="empty">此帳號無法進入這個頁面。</div>`, user));
    return null;
  }
  return user;
}

function slugify(input) {
  const base = String(input || "store").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "store";
  let slug = base;
  let i = 2;
  while (db.prepare("SELECT id FROM stores WHERE platform_slug = ?").get(slug)) slug = `${base}-${i++}`;
  return slug;
}

function storeForUser(user) {
  if (!user.store_id) return null;
  return db.prepare("SELECT * FROM stores WHERE id = ?").get(user.store_id);
}

function getStats(storeId) {
  const where = storeId ? "AND store_id = ?" : "";
  const params = storeId ? [storeId] : [];
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'purchase' AND status = 'completed' THEN points ELSE 0 END), 0) AS purchase_points,
      COALESCE(SUM(CASE WHEN type = 'gift' AND status = 'completed' THEN points ELSE 0 END), 0) AS gift_points,
      COALESCE(SUM(CASE WHEN type = 'consume' AND status = 'completed' THEN points ELSE 0 END), 0) AS consume_points
    FROM point_transactions
    WHERE 1 = 1 ${where}
  `).get(...params);
  row.balance_points = row.purchase_points + row.gift_points - row.consume_points;
  return row;
}

function memberStats(memberId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'purchase' AND status = 'completed' THEN points ELSE 0 END), 0) AS purchase_points,
      COALESCE(SUM(CASE WHEN type = 'gift' AND status = 'completed' THEN points ELSE 0 END), 0) AS gift_points,
      COALESCE(SUM(CASE WHEN type = 'consume' AND status = 'completed' THEN points ELSE 0 END), 0) AS consume_points
    FROM point_transactions
    WHERE member_id = ?
  `).get(memberId);
  row.balance_points = row.purchase_points + row.gift_points - row.consume_points;
  return row;
}

function nav(user) {
  if (!user) return "";
  const links = user.role === "admin"
    ? [["/admin/dashboard", "儀表板"], ["/admin/stores", "分店列表"], ["/admin/stores/new", "新增分店"]]
    : user.role === "store"
      ? [["/store/dashboard", "儀表板"], ["/store/members", "會員列表"], ["/store/members/new", "新增會員"], ["/store/deductions", "扣點要求"]]
      : [["/member/dashboard", "會員中心"]];
  links.push(["/account/password", "修改密碼"]);
  return `<nav>${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}<form method="post" action="/logout"><button>登出</button></form></nav>`;
}

function page(title, content, user = null) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}｜卓悅研墨會員點數管理平台</title>
  <style>
    :root{--ink:#24322f;--muted:#6d7773;--line:#e4e8e5;--paper:#fbfaf7;--jade:#e8f2ec;--gold:#b9964d;--deep:#19362f;--white:#fff}
    *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif;background:var(--paper);color:var(--ink);letter-spacing:0}
    a{color:inherit} .shell{min-height:100vh;display:grid;grid-template-columns:260px 1fr}.side{background:#fff;border-right:1px solid var(--line);padding:24px;position:sticky;top:0;height:100vh}.brand{display:flex;gap:12px;align-items:center;margin-bottom:28px}.brand img{width:54px;height:54px;object-fit:contain}.brand b{display:block;font-size:18px}.brand span{color:var(--muted);font-size:13px}nav{display:grid;gap:8px}nav a,nav button,.button{border:1px solid transparent;background:transparent;text-decoration:none;border-radius:8px;padding:11px 12px;font-size:15px;text-align:left;cursor:pointer}nav a:hover,nav button:hover,.button:hover{background:var(--jade)}nav form{margin-top:16px}.main{padding:30px;max-width:1240px;width:100%;margin:auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}.kicker{color:var(--gold);font-weight:700;font-size:13px}.top h1{margin:4px 0 0;font-size:30px}.user{color:var(--muted);font-size:14px}.grid{display:grid;gap:16px}.cards{grid-template-columns:repeat(4,minmax(0,1fr))}.card,.panel{background:#fff;border:1px solid var(--line);border-radius:8px;padding:18px}.metric{color:var(--muted);font-size:14px}.metric strong{display:block;color:var(--deep);font-size:30px;margin-top:8px}.table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}.table th,.table td{text-align:left;padding:13px 14px;border-bottom:1px solid var(--line);vertical-align:top}.table th{background:#f5f7f3;color:#52615c;font-size:13px}.table tr:last-child td{border-bottom:0}.actions{display:flex;gap:8px;flex-wrap:wrap}.button{display:inline-flex;align-items:center;justify-content:center;background:var(--deep);color:#fff;border-color:var(--deep);min-height:40px}.button.secondary{background:#fff;color:var(--deep);border-color:var(--line)}.button.danger{background:#7f2f2f;border-color:#7f2f2f}form.stack{display:grid;gap:14px;max-width:620px}.field{display:grid;gap:6px}.field label{font-weight:700;font-size:14px}.field input,.field select,.field textarea{border:1px solid var(--line);border-radius:8px;padding:12px 13px;font:inherit;background:#fff}.field textarea{min-height:90px}.login{min-height:100vh;display:grid;grid-template-columns:minmax(360px,480px) 1fr;background:#fff}.login-card{padding:44px;display:flex;flex-direction:column;justify-content:center}.login-card .brand img{width:70px;height:70px}.hero{background:url("/public/hero-business.png") center/cover no-repeat;position:relative}.hero:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.18),rgba(255,255,255,0))}.notice{padding:12px 14px;background:var(--jade);border:1px solid #d5e4db;border-radius:8px;margin-bottom:16px;color:#35534a}.empty{background:#fff;border:1px dashed var(--line);border-radius:8px;padding:28px;color:var(--muted)}.split{grid-template-columns:1.1fr .9fr}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:4px 9px;font-size:12px;color:#52615c;background:#fff}.muted{color:var(--muted)}@media(max-width:860px){.shell{grid-template-columns:1fr}.side{position:static;height:auto}.main{padding:20px}.cards,.split{grid-template-columns:1fr}.login{grid-template-columns:1fr}.hero{display:none}.top{display:block}.table{font-size:14px}}
  </style>
</head>
<body>
  <div class="${user ? "shell" : ""}">
    ${user ? `<aside class="side"><div class="brand"><img src="/public/logo.png" alt="Logo"><div><b>卓悅研墨</b><span>會員點數管理平台</span></div></div>${nav(user)}</aside>` : ""}
    <main class="${user ? "main" : ""}">${user ? `<div class="top"><div><div class="kicker">JOY YANMO POINTS</div><h1>${escapeHtml(title)}</h1></div><div class="user">${escapeHtml(user.name)}・${escapeHtml(user.role)}</div></div>` : ""}${content}</main>
  </div>
</body>
</html>`;
}

function loginPage(role, error = "", slug = "") {
  const title = role === "admin" ? "總部登入" : role === "store" ? "分店登入" : "會員登入";
  return page(title, `<div class="login">
    <section class="login-card">
      <div class="brand"><img src="/public/logo.png" alt="Logo"><div><b>卓悅研墨</b><span>會員點數管理平台</span></div></div>
      <h1>${title}</h1>
      <p class="muted">請使用您的 ${title.replace("登入", "")} 帳號進入平台。</p>
      ${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}
      <form class="stack" method="post" action="/login">
        <input type="hidden" name="role" value="${role}">
        <input type="hidden" name="slug" value="${escapeHtml(slug)}">
        <div class="field"><label>Email</label><input name="email" type="email" required autofocus></div>
        <div class="field"><label>密碼</label><input name="password" type="password" required></div>
        <button class="button">登入</button>
      </form>
      <p class="muted">測試密碼：password123</p>
    </section>
    <section class="hero"></section>
  </div>`);
}

function passwordPage(user, error = "") {
  return page("修改密碼", `<div class="panel">
    ${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}
    <form class="stack" method="post" action="/account/password">
      <div class="field"><label>目前密碼</label><input name="current_password" type="password" autocomplete="current-password" required autofocus></div>
      <div class="field"><label>新密碼</label><input name="new_password" type="password" autocomplete="new-password" minlength="8" required></div>
      <div class="field"><label>確認新密碼</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="button">更新密碼並重新登入</button>
    </form>
  </div>`, user);
}

function renderStatsCards(stats) {
  return `<div class="grid cards">
    <div class="card metric">購買點數總計<strong>${money(stats.purchase_points)}</strong></div>
    <div class="card metric">消費點數總計<strong>${money(stats.consume_points)}</strong></div>
    <div class="card metric">結餘點數總計<strong>${money(stats.balance_points)}</strong></div>
    <div class="card metric">贈予點數總計<strong>${money(stats.gift_points)}</strong></div>
  </div>`;
}

function renderTransactions(rows) {
  if (!rows.length) return `<div class="empty">尚無點數紀錄。</div>`;
  return `<table class="table"><thead><tr><th>時間</th><th>類型</th><th>點數</th><th>狀態</th><th>說明</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td>${escapeHtml(r.created_at)}</td><td>${zhType[r.type]}</td><td>${money(r.points)}</td><td><span class="badge">${zhStatus[r.status]}</span></td><td>${escapeHtml(r.description || "")}</td></tr>
  `).join("")}</tbody></table>`;
}

function adminDashboard(req, res, user) {
  const stores = db.prepare("SELECT COUNT(*) AS count FROM stores").get().count;
  const members = db.prepare("SELECT COUNT(*) AS count FROM members").get().count;
  const stats = getStats();
  send(res, 200, page("總部儀表板", `${renderStatsCards(stats)}<div class="grid split" style="margin-top:16px">
    <div class="panel"><h2>平台概況</h2><p>目前共有 <b>${stores}</b> 間分店、<b>${members}</b> 位會員。</p><a class="button" href="/admin/stores">管理分店</a></div>
    <div class="panel"><h2>快速新增分店</h2>${storeForm()}</div>
  </div>`, user));
}

function storeForm(error = "", values = {}) {
  return `${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}<form class="stack" method="post" action="/admin/stores">
    <div class="field"><label>分店名稱</label><input name="store_name" value="${escapeHtml(values.store_name || "")}" required></div>
    <div class="field"><label>聯絡人</label><input name="contact_name" value="${escapeHtml(values.contact_name || "")}" required></div>
    <div class="field"><label>電話</label><input name="phone" value="${escapeHtml(values.phone || "")}" required></div>
    <div class="field"><label>Email / 登入帳號</label><input name="email" type="email" value="${escapeHtml(values.email || "")}" required></div>
    <div class="field"><label>初始密碼</label><input name="password" value="${escapeHtml(values.password || "password123")}" required></div>
    <button class="button">建立分店</button>
  </form>`;
}

function adminStores(req, res, user) {
  const rows = db.prepare("SELECT * FROM stores ORDER BY id DESC").all();
  const table = rows.length ? `<table class="table"><thead><tr><th>分店</th><th>聯絡人</th><th>Email</th><th>專屬連結</th><th>操作</th></tr></thead><tbody>${rows.map((s) => `
    <tr><td>${escapeHtml(s.store_name)}</td><td>${escapeHtml(s.contact_name)}<br><span class="muted">${escapeHtml(s.phone)}</span></td><td>${escapeHtml(s.email)}</td><td><a href="/store/${escapeHtml(s.platform_slug)}/login">/store/${escapeHtml(s.platform_slug)}/login</a></td><td class="actions"><a class="button secondary" href="/admin/stores/${s.id}">詳細</a><a class="button" href="/admin/stores/${s.id}/view">進入後台</a></td></tr>
  `).join("")}</tbody></table>` : `<div class="empty">尚未建立分店。</div>`;
  send(res, 200, page("分店列表", `<div class="actions" style="margin-bottom:16px"><a class="button" href="/admin/stores/new">新增分店</a></div>${table}`, user));
}

function adminStoreDetail(req, res, user, id) {
  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(id);
  if (!store) return send(res, 404, page("找不到分店", `<div class="empty">找不到指定分店。</div>`, user));
  const stats = getStats(store.id);
  const members = db.prepare("SELECT COUNT(*) AS count FROM members WHERE store_id = ?").get(store.id).count;
  send(res, 200, page("分店詳細資料", `${renderStatsCards(stats)}<div class="panel" style="margin-top:16px">
    <h2>${escapeHtml(store.store_name)}</h2>
    <p>聯絡人：${escapeHtml(store.contact_name)}｜電話：${escapeHtml(store.phone)}｜Email：${escapeHtml(store.email)}</p>
    <p>會員數：${members}</p>
    <p>專屬登入連結：<a href="/store/${escapeHtml(store.platform_slug)}/login">/store/${escapeHtml(store.platform_slug)}/login</a></p>
    <a class="button" href="/admin/stores/${store.id}/view">以分店視角查看</a>
  </div>`, user));
}

function renderStoreDashboard(res, user, storeId, adminView = false) {
  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);
  if (!store) return send(res, 404, page("找不到分店", `<div class="empty">找不到指定分店。</div>`, user));
  const stats = getStats(store.id);
  const pending = db.prepare("SELECT COUNT(*) AS count FROM deduction_requests WHERE store_id = ? AND status = 'pending'").get(store.id).count;
  const members = db.prepare("SELECT COUNT(*) AS count FROM members WHERE store_id = ?").get(store.id).count;
  send(res, 200, page(`${adminView ? "分店後台視角：" : ""}${store.store_name}`, `${adminView ? `<div class="notice">目前為總部進入分店視角，資料唯讀瀏覽與一般分店畫面一致。</div>` : ""}
    ${renderStatsCards(stats)}
    <div class="grid split" style="margin-top:16px">
      <div class="panel"><h2>分店概況</h2><p>會員 ${members} 位，待會員核准扣點 ${pending} 筆。</p><div class="actions"><a class="button" href="/store/members">會員列表</a><a class="button secondary" href="/store/deductions">扣點要求</a></div></div>
      <div class="panel"><h2>新增會員</h2>${memberForm()}</div>
    </div>`, user));
}

function memberForm(error = "", values = {}) {
  return `${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}<form class="stack" method="post" action="/store/members">
    <div class="field"><label>姓名</label><input name="name" value="${escapeHtml(values.name || "")}" required></div>
    <div class="field"><label>電話</label><input name="phone" value="${escapeHtml(values.phone || "")}" required></div>
    <div class="field"><label>Email / 會員登入帳號</label><input name="email" type="email" value="${escapeHtml(values.email || "")}" required></div>
    <div class="field"><label>初始密碼</label><input name="password" value="${escapeHtml(values.password || "password123")}" required></div>
    <button class="button">建立會員</button>
  </form>`;
}

function storeMembers(req, res, user) {
  const rows = db.prepare(`
    SELECT m.*, 
      COALESCE(SUM(CASE WHEN pt.type = 'purchase' AND pt.status = 'completed' THEN pt.points ELSE 0 END), 0) AS purchase_points,
      COALESCE(SUM(CASE WHEN pt.type = 'gift' AND pt.status = 'completed' THEN pt.points ELSE 0 END), 0) AS gift_points,
      COALESCE(SUM(CASE WHEN pt.type = 'consume' AND pt.status = 'completed' THEN pt.points ELSE 0 END), 0) AS consume_points
    FROM members m
    LEFT JOIN point_transactions pt ON pt.member_id = m.id
    WHERE m.store_id = ?
    GROUP BY m.id
    ORDER BY m.id DESC
  `).all(user.store_id);
  const table = rows.length ? `<table class="table"><thead><tr><th>會員</th><th>電話</th><th>購買</th><th>贈予</th><th>剩餘</th><th>操作</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td>${escapeHtml(m.name)}<br><span class="muted">${escapeHtml(m.email)}</span></td><td>${escapeHtml(m.phone)}</td><td>${money(m.purchase_points)}</td><td>${money(m.gift_points)}</td><td>${money(m.purchase_points + m.gift_points - m.consume_points)}</td><td><a class="button secondary" href="/store/members/${m.id}">詳細</a></td></tr>
  `).join("")}</tbody></table>` : `<div class="empty">尚無會員。</div>`;
  send(res, 200, page("會員列表", `<div class="actions" style="margin-bottom:16px"><a class="button" href="/store/members/new">新增會員</a></div>${table}`, user));
}

function storeMemberDetail(req, res, user, id) {
  const member = db.prepare("SELECT * FROM members WHERE id = ? AND store_id = ?").get(id, user.store_id);
  if (!member) return send(res, 404, page("找不到會員", `<div class="empty">找不到會員。</div>`, user));
  const stats = memberStats(member.id);
  const tx = db.prepare("SELECT * FROM point_transactions WHERE member_id = ? ORDER BY id DESC").all(member.id);
  send(res, 200, page("會員詳細資料", `${renderStatsCards(stats)}
    <div class="grid split" style="margin-top:16px">
      <div class="panel"><h2>${escapeHtml(member.name)}</h2><p>${escapeHtml(member.phone)}｜${escapeHtml(member.email)}</p><h3>消費與點數紀錄</h3>${renderTransactions(tx)}</div>
      <div class="panel"><h2>新增點數 / 扣點要求</h2>
        <form class="stack" method="post" action="/store/members/${member.id}/transactions">
          <div class="field"><label>類型</label><select name="type"><option value="purchase">購買點數</option><option value="gift">贈予點數</option></select></div>
          <div class="field"><label>點數</label><input name="points" type="number" min="1" required></div>
          <div class="field"><label>說明</label><input name="description"></div>
          <button class="button">新增紀錄</button>
        </form>
        <hr style="border:0;border-top:1px solid var(--line);margin:22px 0">
        <form class="stack" method="post" action="/store/members/${member.id}/deductions">
          <div class="field"><label>扣點點數</label><input name="points" type="number" min="1" required></div>
          <div class="field"><label>扣點說明</label><input name="description" required></div>
          <button class="button secondary">發送扣點要求</button>
        </form>
      </div>
    </div>`, user));
}

function storeDeductions(req, res, user) {
  const rows = db.prepare(`
    SELECT dr.*, m.name AS member_name, m.email AS member_email
    FROM deduction_requests dr JOIN members m ON m.id = dr.member_id
    WHERE dr.store_id = ?
    ORDER BY dr.id DESC
  `).all(user.store_id);
  const table = rows.length ? `<table class="table"><thead><tr><th>會員</th><th>點數</th><th>狀態</th><th>說明</th><th>建立時間</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td>${escapeHtml(r.member_name)}<br><span class="muted">${escapeHtml(r.member_email)}</span></td><td>${money(r.points)}</td><td><span class="badge">${zhStatus[r.status]}</span></td><td>${escapeHtml(r.description || "")}</td><td>${escapeHtml(r.created_at)}</td></tr>
  `).join("")}</tbody></table>` : `<div class="empty">尚無扣點要求。</div>`;
  send(res, 200, page("扣點要求列表", table, user));
}

function memberDashboard(req, res, user) {
  const member = db.prepare("SELECT * FROM members WHERE user_id = ?").get(user.id);
  if (!member) return send(res, 404, page("找不到會員資料", `<div class="empty">此帳號尚未連結會員資料。</div>`, user));
  const stats = memberStats(member.id);
  const tx = db.prepare("SELECT * FROM point_transactions WHERE member_id = ? ORDER BY id DESC").all(member.id);
  const pending = db.prepare("SELECT * FROM deduction_requests WHERE member_id = ? AND status = 'pending' ORDER BY id DESC").all(member.id);
  const pendingHtml = pending.length ? `<table class="table"><thead><tr><th>點數</th><th>說明</th><th>時間</th><th>操作</th></tr></thead><tbody>${pending.map((r) => `
    <tr><td>${money(r.points)}</td><td>${escapeHtml(r.description || "")}</td><td>${escapeHtml(r.created_at)}</td><td class="actions"><form method="post" action="/member/deductions/${r.id}/approve"><button class="button">核准</button></form><form method="post" action="/member/deductions/${r.id}/reject"><button class="button danger">拒絕</button></form></td></tr>
  `).join("")}</tbody></table>` : `<div class="empty">目前沒有待核准扣點要求。</div>`;
  send(res, 200, page("我的點數總覽", `${renderStatsCards(stats)}
    <div class="grid split" style="margin-top:16px">
      <div class="panel"><h2>待核准扣點要求</h2>${pendingHtml}</div>
      <div class="panel"><h2>點數與消費紀錄</h2>${renderTransactions(tx)}</div>
    </div>`, user));
}

async function handlePost(req, res, pathname) {
  const body = await readBody(req);
  if (pathname === "/login") {
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND role = ?").get(body.email, body.role);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return send(res, 401, loginPage(body.role || "member", "帳號或密碼不正確。", body.slug || ""));
    }
    if (body.role === "store" && body.slug) {
      const store = db.prepare("SELECT * FROM stores WHERE platform_slug = ?").get(body.slug);
      if (!store || store.id !== user.store_id) return send(res, 403, loginPage("store", "此帳號不屬於這個分店連結。", body.slug));
    }
    const target = user.role === "admin" ? "/admin/dashboard" : user.role === "store" ? "/store/dashboard" : "/member/dashboard";
    res.writeHead(302, { "Set-Cookie": `session=${encodeURIComponent(makeToken(user))}; HttpOnly; SameSite=Lax; Path=/; ${COOKIE_SECURE ? "Secure; " : ""}`, Location: target });
    return res.end();
  }
  if (pathname === "/logout") {
    res.writeHead(302, { "Set-Cookie": "session=; Max-Age=0; Path=/", Location: "/" });
    return res.end();
  }
  if (pathname === "/account/password") {
    const sessionUser = requireUser(req, res, ["admin", "store", "member"]); if (!sessionUser) return;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(sessionUser.id);
    if (!verifyPassword(body.current_password || "", user.password_hash)) {
      return send(res, 400, passwordPage(sessionUser, "目前密碼不正確。"));
    }
    if ((body.new_password || "") !== (body.confirm_password || "")) {
      return send(res, 400, passwordPage(sessionUser, "新密碼與確認新密碼不一致。"));
    }
    if (String(body.new_password || "").length < 8) {
      return send(res, 400, passwordPage(sessionUser, "新密碼至少需要 8 個字元。"));
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(body.new_password), user.id);
    res.writeHead(302, {
      "Set-Cookie": "session=; Max-Age=0; Path=/",
      Location: `${loginPathForRole(user.role)}?passwordChanged=1`
    });
    return res.end();
  }
  if (pathname === "/admin/stores") {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    try {
      const slug = slugify(body.store_name);
      db.exec("BEGIN");
      const store = db.prepare(`
        INSERT INTO stores (store_name, contact_name, phone, email, platform_slug)
        VALUES (?, ?, ?, ?, ?) RETURNING id
      `).get(body.store_name, body.contact_name, body.phone, body.email, slug);
      db.prepare(`
        INSERT INTO users (role, name, phone, email, password_hash, store_id)
        VALUES ('store', ?, ?, ?, ?, ?)
      `).run(body.store_name, body.phone, body.email, hashPassword(body.password || "password123"), store.id);
      db.exec("COMMIT");
      return redirect(res, `/admin/stores/${store.id}`);
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintError(error)) {
        return send(res, 400, page("新增分店", storeForm(duplicateEmailMessage(), body), user));
      }
      throw error;
    }
  }
  if (pathname === "/store/members") {
    const user = requireUser(req, res, ["store"]); if (!user) return;
    try {
      db.exec("BEGIN");
      const newUser = db.prepare(`
        INSERT INTO users (role, name, phone, email, password_hash, store_id)
        VALUES ('member', ?, ?, ?, ?, ?) RETURNING id
      `).get(body.name, body.phone, body.email, hashPassword(body.password || "password123"), user.store_id);
      const member = db.prepare(`
        INSERT INTO members (store_id, user_id, name, phone, email)
        VALUES (?, ?, ?, ?, ?) RETURNING id
      `).get(user.store_id, newUser.id, body.name, body.phone, body.email);
      db.exec("COMMIT");
      return redirect(res, `/store/members/${member.id}`);
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintError(error)) {
        return send(res, 400, page("新增會員", memberForm(duplicateEmailMessage(), body), user));
      }
      throw error;
    }
  }
  const txMatch = pathname.match(/^\/store\/members\/(\d+)\/transactions$/);
  if (txMatch) {
    const user = requireUser(req, res, ["store"]); if (!user) return;
    const member = db.prepare("SELECT id FROM members WHERE id = ? AND store_id = ?").get(txMatch[1], user.store_id);
    if (!member) return send(res, 404, page("找不到會員", `<div class="empty">找不到會員。</div>`, user));
    db.prepare(`
      INSERT INTO point_transactions (store_id, member_id, type, points, description, status)
      VALUES (?, ?, ?, ?, ?, 'completed')
    `).run(user.store_id, member.id, body.type === "gift" ? "gift" : "purchase", Number(body.points), body.description || "");
    return redirect(res, `/store/members/${member.id}`);
  }
  const deductMatch = pathname.match(/^\/store\/members\/(\d+)\/deductions$/);
  if (deductMatch) {
    const user = requireUser(req, res, ["store"]); if (!user) return;
    const member = db.prepare("SELECT id FROM members WHERE id = ? AND store_id = ?").get(deductMatch[1], user.store_id);
    if (!member) return send(res, 404, page("找不到會員", `<div class="empty">找不到會員。</div>`, user));
    db.prepare(`
      INSERT INTO deduction_requests (store_id, member_id, points, description, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(user.store_id, member.id, Number(body.points), body.description || "");
    return redirect(res, "/store/deductions");
  }
  const decisionMatch = pathname.match(/^\/member\/deductions\/(\d+)\/(approve|reject)$/);
  if (decisionMatch) {
    const user = requireUser(req, res, ["member"]); if (!user) return;
    const member = db.prepare("SELECT * FROM members WHERE user_id = ?").get(user.id);
    const request = db.prepare("SELECT * FROM deduction_requests WHERE id = ? AND member_id = ? AND status = 'pending'").get(decisionMatch[1], member?.id);
    if (!request) return redirect(res, "/member/dashboard");
    if (decisionMatch[2] === "reject") {
      db.prepare("UPDATE deduction_requests SET status = 'rejected' WHERE id = ?").run(request.id);
      return redirect(res, "/member/dashboard");
    }
    const stats = memberStats(member.id);
    if (stats.balance_points < request.points) {
      return send(res, 400, page("點數不足", `<div class="empty">目前結餘點數不足，無法核准此扣點要求。</div><p><a class="button" href="/member/dashboard">返回會員中心</a></p>`, user));
    }
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE deduction_requests SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(request.id);
      db.prepare(`
        INSERT INTO point_transactions (store_id, member_id, type, points, description, status)
        VALUES (?, ?, 'consume', ?, ?, 'completed')
      `).run(request.store_id, request.member_id, request.points, request.description || "會員核准扣點");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return redirect(res, "/member/dashboard");
  }
  send(res, 404, "Not found");
}

function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/public\//, ""));
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return false;
  const ext = path.extname(file).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function router(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (pathname === "/healthz") return sendText(res, 200, "ok");
    if (pathname.startsWith("/public/") && serveStatic(res, pathname)) return;
    if (req.method === "POST") return handlePost(req, res, pathname);

    if (pathname === "/") return redirect(res, "/admin/login");
    const passwordChangedMessage = url.searchParams.get("passwordChanged") ? "密碼已更新，請使用新密碼重新登入。" : "";
    if (pathname === "/admin/login") return send(res, 200, loginPage("admin", passwordChangedMessage));
    if (pathname === "/store/login") return send(res, 200, loginPage("store", passwordChangedMessage));
    if (pathname === "/member/login") return send(res, 200, loginPage("member", passwordChangedMessage));
    const slugLogin = pathname.match(/^\/store\/([^/]+)\/login$/);
    if (slugLogin) return send(res, 200, loginPage("store", "", slugLogin[1]));

    if (pathname === "/account/password") {
      const user = requireUser(req, res, ["admin", "store", "member"]);
      if (user) return send(res, 200, passwordPage(user));
      return;
    }

    if (pathname === "/admin/dashboard") { const user = requireUser(req, res, ["admin"]); if (user) return adminDashboard(req, res, user); return; }
    if (pathname === "/admin/stores") { const user = requireUser(req, res, ["admin"]); if (user) return adminStores(req, res, user); return; }
    if (pathname === "/admin/stores/new") { const user = requireUser(req, res, ["admin"]); if (user) return send(res, 200, page("新增分店", storeForm(), user)); return; }
    const adminStore = pathname.match(/^\/admin\/stores\/(\d+)$/);
    if (adminStore) { const user = requireUser(req, res, ["admin"]); if (user) return adminStoreDetail(req, res, user, adminStore[1]); return; }
    const adminView = pathname.match(/^\/admin\/stores\/(\d+)\/view$/);
    if (adminView) { const user = requireUser(req, res, ["admin"]); if (user) return renderStoreDashboard(res, user, adminView[1], true); return; }

    if (pathname === "/store/dashboard") { const user = requireUser(req, res, ["store"]); if (user) return renderStoreDashboard(res, user, user.store_id); return; }
    if (pathname === "/store/members") { const user = requireUser(req, res, ["store"]); if (user) return storeMembers(req, res, user); return; }
    if (pathname === "/store/members/new") { const user = requireUser(req, res, ["store"]); if (user) return send(res, 200, page("新增會員", memberForm(), user)); return; }
    const memberDetail = pathname.match(/^\/store\/members\/(\d+)$/);
    if (memberDetail) { const user = requireUser(req, res, ["store"]); if (user) return storeMemberDetail(req, res, user, memberDetail[1]); return; }
    if (pathname === "/store/deductions") { const user = requireUser(req, res, ["store"]); if (user) return storeDeductions(req, res, user); return; }

    if (pathname === "/member/dashboard") { const user = requireUser(req, res, ["member"]); if (user) return memberDashboard(req, res, user); return; }

    send(res, 404, page("找不到頁面", `<div class="empty">找不到這個頁面。</div>`, currentUser(req)));
  } catch (error) {
    console.error(error);
    if (isUniqueConstraintError(error)) {
      return send(res, 400, page("資料重複", `<div class="notice">${duplicateEmailMessage()}</div>`, currentUser(req)));
    }
    send(res, 500, page("系統錯誤", `<div class="empty">${escapeHtml(error.message)}</div>`, currentUser(req)));
  }
}

if (!db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) {
  console.log("No seed data found. Run: node scripts/seed.js");
}

http.createServer(router).listen(PORT, HOST, () => {
  console.log(`卓悅研墨會員點數管理平台 running at http://${HOST}:${PORT}`);
});
