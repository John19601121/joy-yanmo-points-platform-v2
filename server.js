const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { v2: cloudinary } = require("cloudinary");
const { applyMigrations } = require("./lib/migrations");
const memberFoundation = require("./lib/member-foundation");
const activationEmail = require("./lib/activation-email");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || "data/app.sqlite");
const SCHEMA_PATH = path.join(ROOT, "schema.sql");
const PUBLIC_DIR = path.join(ROOT, "public");
const PUBLIC_IMAGES_DIR = path.join(PUBLIC_DIR, "images");
const PLATFORM_NAME = "LT 大健康成交會員積分管理平台";
const PLATFORM_VERSION = "V1.0 正式版";
const EXPORT_PREFIX = "lt-health-sales-points";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("base64url");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
const SUPER_ADMIN_EMAIL = String(process.env.INITIAL_ADMIN_EMAIL || "").trim().toLowerCase();
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || "lt-health-products";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 256 * 1024;
const MAX_FORM_BYTES = 64 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const configuredActivationTtl = Number.parseInt(process.env.ACTIVATION_TOKEN_TTL_MINUTES || "1440", 10);
const ACTIVATION_TOKEN_TTL_MINUTES = Number.isFinite(configuredActivationTtl)
  ? Math.max(15, configuredActivationTtl)
  : 1440;
const ACTIVATION_EMAIL_EVENTS = ["activation_email_requested"];

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

if (process.env.NODE_ENV === "production") {
  if (!process.env.SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error("Production requires SESSION_SECRET with at least 32 characters.");
  }
  if (!SUPER_ADMIN_EMAIL || !process.env.INITIAL_ADMIN_PASSWORD) {
    throw new Error("Production requires INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD.");
  }
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
runMigrations();
applyMigrations(db, path.join(ROOT, "migrations"));

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

function generateTemporaryPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function validInitialPassword(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}

function validMemberName(value) {
  const length = String(value || "").trim().length;
  return length >= 2 && length <= 80;
}

function validMemberEmail(value) {
  const email = memberFoundation.normalizeEmail(value);
  return Boolean(email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function validMemberPhone(value) {
  return /^09\d{8}$/.test(memberFoundation.normalizePhone(value) || "");
}

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function runMigrations() {
  const userSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || "";
  if (userSql.includes("email TEXT NOT NULL UNIQUE")) {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK (role IN ('admin', 'store', 'member')),
          name TEXT NOT NULL,
          phone TEXT,
          email TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          store_id INTEGER,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          is_super_admin INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (store_id) REFERENCES stores(id)
        );
      `);
      db.exec(`
        INSERT INTO users_new (id, role, name, phone, email, password_hash, store_id, status, is_super_admin, created_at)
        SELECT id, role, name, phone, email, password_hash, store_id, 'active', 0, created_at FROM users;
      `);
      db.exec("DROP TABLE users;");
      db.exec("ALTER TABLE users_new RENAME TO users;");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
  if (!columnExists("users", "status")) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
  if (!columnExists("users", "is_super_admin")) db.exec("ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0;");
  if (!columnExists("members", "member_code")) db.exec("ALTER TABLE members ADD COLUMN member_code TEXT;");
  if (!columnExists("products", "media_asset_id")) db.exec("ALTER TABLE products ADD COLUMN media_asset_id INTEGER;");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_members_member_code ON members(member_code);");
  db.exec("DROP INDEX IF EXISTS idx_users_admin_email;");
  db.exec("DROP INDEX IF EXISTS idx_users_member_email;");
  db.exec("DROP INDEX IF EXISTS idx_users_store_email_store;");
  db.exec("DROP INDEX IF EXISTS idx_users_store_email;");
  for (const role of ["admin", "store", "member"]) {
    try {
      db.exec(`CREATE UNIQUE INDEX idx_users_${role}_email ON users(lower(email), role) WHERE role = '${role}';`);
    } catch (error) {
      console.warn(`既有資料含有重複的 ${role} Email；系統將阻止新增同角色重複 Email，請由總部管理員整理既有帳號。`, error.message);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_account_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL CHECK (role IN ('admin', 'store')),
      store_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
      user_id INTEGER,
      requested_by INTEGER,
      reviewed_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      disabled_at TEXT,
      FOREIGN KEY (store_id) REFERENCES stores(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (requested_by) REFERENCES users(id),
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK (event_type IN ('login', 'logout')),
      login_email TEXT NOT NULL,
      admin_name TEXT,
      ip TEXT,
      user_agent TEXT,
      result TEXT NOT NULL CHECK (result IN ('success', 'failed')),
      failure_reason TEXT,
      user_id INTEGER,
      event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  ensureSuperAdmin();
  backfillMemberCodes();
  ensureDefaultProducts();
}

function ensureSuperAdmin() {
  if (!SUPER_ADMIN_EMAIL) return;
  db.exec("CREATE TABLE IF NOT EXISTS app_security_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);");
  const existing = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'admin'").get(SUPER_ADMIN_EMAIL);
  if (existing) {
    db.prepare("UPDATE users SET is_super_admin = 1, status = 'active' WHERE id = ?").run(existing.id);
    const migrationName = "p0-rotate-bootstrap-admin-credentials-v1";
    const migrated = db.prepare("SELECT name FROM app_security_migrations WHERE name = ?").get(migrationName);
    if (!migrated && process.env.INITIAL_ADMIN_PASSWORD) {
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(process.env.INITIAL_ADMIN_PASSWORD), existing.id);
        db.prepare("INSERT INTO app_security_migrations (name) VALUES (?)").run(migrationName);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return;
  }
  if (!process.env.INITIAL_ADMIN_PASSWORD) return;
  db.prepare(`
    INSERT INTO users (role, name, phone, email, password_hash, status, is_super_admin)
    VALUES ('admin', '總部專職管理員', '', ?, ?, 'active', 1)
  `).run(SUPER_ADMIN_EMAIL, hashPassword(process.env.INITIAL_ADMIN_PASSWORD));
}

function generateMemberCode() {
  const ym = new Date().toISOString().slice(0, 7).replace("-", "");
  const prefix = `LT${ym}`;
  const last = db.prepare("SELECT member_code FROM members WHERE member_code LIKE ? ORDER BY member_code DESC LIMIT 1").get(`${prefix}%`);
  const next = last?.member_code ? Number(last.member_code.slice(-5)) + 1 : 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}

function backfillMemberCodes() {
  const rows = db.prepare("SELECT id FROM members WHERE member_code IS NULL OR member_code = '' ORDER BY id").all();
  for (const row of rows) {
    let code = generateMemberCode();
    while (db.prepare("SELECT id FROM members WHERE member_code = ?").get(code)) code = generateMemberCode();
    db.prepare("UPDATE members SET member_code = ? WHERE id = ?").run(code, row.id);
  }
}

function ensureDefaultProducts() {
  const type = db.prepare("SELECT id FROM product_types WHERE name = ?").get("用品")
    || db.prepare("INSERT INTO product_types (name, sort_order, is_active) VALUES (?, 10, 1) RETURNING id").get("用品");
  const category = db.prepare("SELECT id FROM product_categories WHERE type_id = ? AND name = ?").get(type.id, "清潔用品")
    || db.prepare("INSERT INTO product_categories (type_id, name, sort_order, is_active) VALUES (?, ?, 10, 1) RETURNING id").get(type.id, "清潔用品");
  const existing = db.prepare("SELECT id FROM products WHERE product_code = ?").get("SOAP001");
  if (existing) return;
  db.prepare(`
    INSERT INTO products (product_code, name, type_id, category_id, short_description, product_page_url, price, currency, payment_provider, is_active, sort_order)
    VALUES ('SOAP001', '烏金炭皂', ?, ?, '深層清潔、溫和調理的黑金炭皂', 'https://opx-1.my.canva.site/daho3zigbkc', NULL, 'TWD', 'ecpay', 1, 10)
  `).run(type.id, category.id);
}

function verifyPassword(password, stored) {
  const [method, iterText, salt, hash] = String(stored || "").split("$");
  if (method !== "pbkdf2" || !iterText || !salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, Number(iterText), 32, "sha256").toString("base64url");
  const candidateBuffer = Buffer.from(candidate);
  const hashBuffer = Buffer.from(hash);
  return candidateBuffer.length === hashBuffer.length && crypto.timingSafeEqual(candidateBuffer, hashBuffer);
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
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(sig);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < Date.now()) return null;
  const user = db.prepare("SELECT id, role, name, email, phone, store_id, status, is_super_admin FROM users WHERE id = ?").get(data.id) || null;
  if (user?.status === "disabled") return null;
  return user;
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split("=");
    try {
      return [key, decodeURIComponent(rest.join("="))];
    } catch {
      return [key, ""];
    }
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

function priceLabel(price, currency = "TWD") {
  if (price === null || price === undefined || price === "") return "價格洽詢";
  return `${currency === "TWD" ? "NT$" : `${escapeHtml(currency)} `}${money(price)}`;
}

function validHttpUrl(value, required = false) {
  const text = String(value || "").trim();
  if (!text) return required ? null : "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isCloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function formatBytes(bytes = 0) {
  const size = Number(bytes || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function cloudinaryOptimizedUrl(url, size = 800) {
  const text = String(url || "");
  if (!text.includes("res.cloudinary.com/") || !text.includes("/upload/")) return text;
  return text.replace("/upload/", `/upload/f_auto,q_auto,c_fill,w_${size},h_${size}/`);
}

function mediaAssets(limit = 24) {
  return db.prepare(`
    SELECT ma.*, u.name AS uploaded_by_name
    FROM media_assets ma
    LEFT JOIN users u ON u.id = ma.uploaded_by_user_id
    WHERE ma.is_active = 1
    ORDER BY ma.id DESC
    LIMIT ?
  `).all(limit);
}

function mediaAssetById(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM media_assets WHERE id = ? AND is_active = 1").get(id) || null;
}

function parseOptionalPrice(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return NaN;
  const price = Number(text);
  return Number.isSafeInteger(price) && price >= 0 ? price : NaN;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function loginPathForRole(role) {
  return role === "admin" ? "/admin/login" : role === "store" ? "/store/login" : "/member/login";
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(), ...headers });
  res.end(body);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders(), ...headers });
  res.end(body);
}

function isUniqueConstraintError(error) {
  return String(error?.code || "").includes("SQLITE_CONSTRAINT_UNIQUE") || /unique constraint/i.test(String(error?.message || ""));
}

function uniqueConstraintMessage(error) {
  const message = String(error?.message || "");
  if (/email|idx_users_.*_email/i.test(message)) return "此 Email 已在相同角色中使用，請更換 Email。";
  if (/members\.store_id, members\.phone/i.test(message)) return "此手機號碼已在本分店使用，請確認會員資料。";
  if (/platform_slug/i.test(message)) return "此分店網址識別碼已存在，請重新送出。";
  if (/member_code/i.test(message)) return "會員編號發生重複，請重新送出。";
  return "資料已存在，請確認後再試。";
}

function emailExistsForRole(email, role) {
  return Boolean(db.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role = ? LIMIT 1").get(String(email || "").trim(), role));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function recordAdminAudit(req, { eventType, email, user = null, result, failureReason = "" }) {
  db.prepare(`
    INSERT INTO admin_audit_logs (event_type, login_email, admin_name, ip, user_agent, result, failure_reason, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventType, email || user?.email || "", user?.name || "", clientIp(req), req.headers["user-agent"] || "", result, failureReason, user?.id || null);
}

function isSuperAdmin(user) {
  return user?.role === "admin" && user.is_super_admin === 1;
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function readBody(req, maxBytes = MAX_FORM_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        raw = "";
        return;
      }
      if (!tooLarge) raw += chunk;
    });
    req.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error("Request body too large."), { statusCode: 413 }));
      else resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on("error", reject);
  });
}

function isSameOriginPost(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const protocol = COOKIE_SECURE ? "https:" : "http:";
    return new URL(origin).origin === `${protocol}//${req.headers.host}`;
  } catch {
    return false;
  }
}

function bufferSplit(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function readMultipartBody(req, maxBytes = MAX_MULTIPART_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new Error("檔案大小超過 5 MB。"));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function parseMultipartForm(req) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("上傳格式不正確。");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const body = await readMultipartBody(req);
  const fields = {};
  const files = {};
  for (let part of bufferSplit(body, boundary)) {
    if (part.length < 4 || part.equals(Buffer.from("--\r\n")) || part.equals(Buffer.from("--"))) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);
    if (part.subarray(-2).toString() === "--") part = part.subarray(0, -2);
    const divider = part.indexOf(Buffer.from("\r\n\r\n"));
    if (divider === -1) continue;
    const rawHeaders = part.subarray(0, divider).toString("utf8");
    const data = part.subarray(divider + 4);
    const disposition = rawHeaders.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const name = disposition.match(/name="([^"]+)"/i)?.[1];
    if (!name) continue;
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const mimeType = rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || "";
    if (filename !== undefined) {
      files[name] = { filename: path.basename(filename), mimeType, data };
    } else {
      fields[name] = data.toString("utf8");
    }
  }
  return { fields, files };
}

function sniffImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function validateImageUpload(file) {
  if (!file || !file.data?.length) throw new Error("請選擇要上傳的圖片。");
  if (file.data.length > MAX_IMAGE_BYTES) throw new Error("單張圖片不可超過 5 MB。");
  const ext = path.extname(file.filename || "").toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) throw new Error("僅支援 JPG、PNG、WebP 圖片。");
  if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimeType)) throw new Error("圖片 Content-Type 不支援。");
  const sniffed = sniffImageMime(file.data);
  if (!sniffed || sniffed !== file.mimeType) throw new Error("檔案內容不是有效的 JPG、PNG 或 WebP 圖片。");
  return sniffed;
}

function uploadToCloudinary(file, mimeType) {
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream({
      resource_type: "image",
      folder: CLOUDINARY_FOLDER,
      use_filename: true,
      unique_filename: true,
      overwrite: false,
      context: { original_filename: file.filename || "" }
    }, (error, result) => {
      if (error) reject(error);
      else resolve({ ...result, mime_type: mimeType });
    });
    upload.end(file.data);
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
    ? [["/admin/dashboard", "儀表板"], ["/admin/stores", "分店列表"], ["/admin/stores/new", "新增分店"], ["/admin/members", "會員列表"], ["/admin/mall", "商城"], ["/admin/media", "媒體中心"], ["/admin/reports", "報表匯出"], ["/admin/manager-requests", "管理員申請"]]
    : user.role === "store"
      ? [["/store/dashboard", "儀表板"], ["/store/members", "會員列表"], ["/store/members/new", "新增會員"], ["/store/cross-store", "跨店扣點"], ["/store/deductions", "扣點要求"], ["/store/mall", "商城"], ["/store/reports", "報表匯出"], ["/store/manager-requests", "管理員申請"]]
      : [["/member/dashboard", "會員中心"], ["/member/mall", "商城"], ["/member/share-center", "我的成交中心"]];
  if (isSuperAdmin(user)) links.push(["/admin/audit-logs", "操作紀錄"]);
  links.push(["/account/password", "修改密碼"]);
  return `<nav>${links.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}<form method="post" action="/logout"><button>登出</button></form></nav>`;
}

function page(title, content, user = null) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}｜${PLATFORM_NAME}</title>
  <link rel="icon" type="image/png" href="/public/favicon.png">
  <style>
    :root{--ink:#24322f;--muted:#6d7773;--line:#e4e8e5;--paper:#fbfaf7;--jade:#e8f2ec;--gold:#b9964d;--deep:#19362f;--white:#fff}
    *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif;background:var(--paper);color:var(--ink);letter-spacing:0}
    a{color:inherit} .shell{min-height:100vh;display:grid;grid-template-columns:260px 1fr}.side{background:#fff;border-right:1px solid var(--line);padding:24px;position:sticky;top:0;height:100vh}.brand{display:flex;gap:12px;align-items:center;margin-bottom:28px}.brand img{width:54px;height:54px;object-fit:contain}.brand b{display:block;font-size:18px}.brand span{color:var(--muted);font-size:13px}nav{display:grid;gap:8px}nav a,nav button,.button{border:1px solid transparent;background:transparent;text-decoration:none;border-radius:8px;padding:11px 12px;font-size:15px;text-align:left;cursor:pointer}nav a:hover,nav button:hover,.button:hover{background:var(--jade)}nav form{margin-top:16px}.main{padding:30px;max-width:1240px;width:100%;margin:auto}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}.kicker{color:var(--gold);font-weight:700;font-size:13px}.top h1{margin:4px 0 0;font-size:30px}.user{color:var(--muted);font-size:14px}.grid{display:grid;gap:16px}.cards{grid-template-columns:repeat(4,minmax(0,1fr))}.card,.panel{background:#fff;border:1px solid var(--line);border-radius:8px;padding:18px}.metric{color:var(--muted);font-size:14px}.metric strong{display:block;color:var(--deep);font-size:30px;margin-top:8px}.table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden}.table th,.table td{text-align:left;padding:13px 14px;border-bottom:1px solid var(--line);vertical-align:top}.table th{background:#f5f7f3;color:#52615c;font-size:13px}.table tr:last-child td{border-bottom:0}.actions{display:flex;gap:8px;flex-wrap:wrap}.button{display:inline-flex;align-items:center;justify-content:center;background:var(--deep);color:#fff;border-color:var(--deep);min-height:40px}.button.secondary{background:#fff;color:var(--deep);border-color:var(--line)}.button.danger{background:#7f2f2f;border-color:#7f2f2f}form.stack{display:grid;gap:14px;max-width:620px}.field{display:grid;gap:6px}.field label{font-weight:700;font-size:14px}.field input,.field select,.field textarea{border:1px solid var(--line);border-radius:8px;padding:12px 13px;font:inherit;background:#fff}.field textarea{min-height:90px}.login{min-height:100vh;display:grid;grid-template-columns:minmax(360px,480px) 1fr;background:#fff}.login-card{padding:44px;display:flex;flex-direction:column;justify-content:center}.login-card .brand img{width:70px;height:70px}.hero{background:url("/public/hero-business.png") center/cover no-repeat;position:relative}.hero:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.18),rgba(255,255,255,0))}.notice{padding:12px 14px;background:var(--jade);border:1px solid #d5e4db;border-radius:8px;margin-bottom:16px;color:#35534a}.empty{background:#fff;border:1px dashed var(--line);border-radius:8px;padding:28px;color:var(--muted)}.split{grid-template-columns:1.1fr .9fr}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:4px 9px;font-size:12px;color:#52615c;background:#fff}.muted{color:var(--muted)}@media(max-width:860px){.shell{grid-template-columns:1fr}.side{position:static;height:auto}.main{padding:20px}.cards,.split{grid-template-columns:1fr}.login{grid-template-columns:1fr}.hero{display:none}.top{display:block}.table{font-size:14px}}
  </style>
</head>
<body>
  <div class="${user ? "shell" : ""}">
    ${user ? `<aside class="side"><div class="brand"><img src="/public/logo.png" alt="LT Logo"><div><b>LT 大健康成交</b><span>會員積分管理平台</span></div></div>${nav(user)}</aside>` : ""}
    <main class="${user ? "main" : ""}">${user ? `<div class="top"><div><div class="kicker">LT HEALTH SALES POINTS・${PLATFORM_VERSION}</div><h1>${escapeHtml(title)}</h1></div><div class="user">${escapeHtml(user.name)}・${escapeHtml(user.role)}</div></div>` : ""}${content}</main>
  </div>
</body>
</html>`;
}

function loginPage(role, error = "", slug = "") {
  const title = role === "admin" ? "總部登入" : role === "store" ? "分店登入" : "會員登入";
  return page(title, `<div class="login">
    <section class="login-card">
      <div class="brand"><img src="/public/logo.png" alt="LT Logo"><div><b>LT 大健康成交</b><span>會員積分管理平台</span></div></div>
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
      ${role === "member" && memberFoundation.featureEnabled(db, "member_self_registration")
        ? `<p><a href="/member/register">尚未加入？建立會員帳號</a></p>`
        : ""}
      ${process.env.NODE_ENV === "production" ? "" : `<p class="muted">本機測試帳號請依開發環境設定。</p>`}
    </section>
    <section class="hero"></section>
  </div>`);
}

function memberRegistrationPage(error = "", values = {}, completed = false) {
  if (completed) {
    return page("會員註冊完成", `<div class="login">
      <section class="login-card">
        <div class="brand"><img src="/public/logo.png" alt="LT Logo"><div><b>LT 大健康成交</b><span>會員積分管理平台</span></div></div>
        <h1>請檢查您的 Email</h1>
        <div class="notice">若資料正確，啟用信將寄至您填寫的 Email。請使用信中的一次性連結設定密碼。</div>
        <p class="muted">沒有收到信？請稍候幾分鐘後使用安全重寄功能。</p>
        <form class="stack" method="post" action="/member/activation/resend">
          <div class="field"><label>Email</label><input name="email" type="email" maxlength="254" required></div>
          <button class="button secondary">重寄啟用信</button>
        </form>
      </section><section class="hero"></section>
    </div>`);
  }
  return page("會員註冊", `<div class="login">
    <section class="login-card">
      <div class="brand"><img src="/public/logo.png" alt="LT Logo"><div><b>LT 大健康成交</b><span>會員積分管理平台</span></div></div>
      <h1>建立會員帳號</h1>
      <p class="muted">完成資料後，系統會建立待啟用帳號。</p>
      ${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}
      <form class="stack" method="post" action="/member/register">
        <div class="field"><label>姓名</label><input name="name" maxlength="80" value="${escapeHtml(values.name || "")}" required autofocus></div>
        <div class="field"><label>Email</label><input name="email" type="email" maxlength="254" autocomplete="email" value="${escapeHtml(values.email || "")}" required></div>
        <div class="field"><label>手機</label><input name="phone" inputmode="tel" maxlength="20" autocomplete="tel" placeholder="0912345678" value="${escapeHtml(values.phone || "")}" required></div>
        <div class="field"><label>推薦碼（選填）</label><input name="referral_code" maxlength="32" value="${escapeHtml(values.referral_code || "")}"></div>
        <button class="button">送出註冊</button>
      </form>
      <p><a href="/member/login">返回會員登入</a></p>
    </section><section class="hero"></section>
  </div>`);
}

function memberActivationPage(token, error = "", success = false) {
  if (success) {
    return page("帳號已啟用", `<div class="login">
      <section class="login-card">
        <div class="brand"><img src="/public/logo.png" alt="LT Logo"><div><b>LT 大健康成交</b><span>會員積分管理平台</span></div></div>
        <h1>帳號啟用完成</h1>
        <div class="notice">密碼已設定，現在可以登入會員中心。</div>
        <p><a class="button" href="/member/login">前往會員登入</a></p>
      </section><section class="hero"></section>
    </div>`);
  }
  return page("啟用會員帳號", `<div class="login">
    <section class="login-card">
      <div class="brand"><img src="/public/logo.png" alt="LT Logo"><div><b>LT 大健康成交</b><span>會員積分管理平台</span></div></div>
      <h1>設定會員密碼</h1>
      ${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}
      <form class="stack" method="post" action="/member/activate">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <div class="field"><label>新密碼</label><input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required autofocus></div>
        <div class="field"><label>確認新密碼</label><input name="confirm_password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></div>
        <button class="button">設定密碼並啟用</button>
      </form>
    </section><section class="hero"></section>
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

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv(res, filename, rows) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const csv = "\ufeff" + [headers.join(","), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(csv);
}

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(value) {
  const b = Buffer.alloc(2); b.writeUInt16LE(value); return b;
}

function writeUInt32(value) {
  const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      writeUInt32(0x04034b50), writeUInt16(20), writeUInt16(0), writeUInt16(0), writeUInt16(0), writeUInt16(0),
      writeUInt32(crc), writeUInt32(data.length), writeUInt32(data.length), writeUInt16(name.length), writeUInt16(0), name, data
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      writeUInt32(0x02014b50), writeUInt16(20), writeUInt16(20), writeUInt16(0), writeUInt16(0), writeUInt16(0), writeUInt16(0),
      writeUInt32(crc), writeUInt32(data.length), writeUInt32(data.length), writeUInt16(name.length), writeUInt16(0), writeUInt16(0),
      writeUInt16(0), writeUInt16(0), writeUInt32(0), writeUInt32(offset), name
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(0x06054b50), writeUInt16(0), writeUInt16(0), writeUInt16(files.length), writeUInt16(files.length),
    writeUInt32(central.length), writeUInt32(offset), writeUInt16(0)
  ]);
  return Buffer.concat([...localParts, central, end]);
}

function xlsxEscape(value) {
  return escapeHtml(value).replace(/\n/g, " ");
}

function sheetXml(rows) {
  const headers = rows[0] ? Object.keys(rows[0]) : ["資料"];
  const allRows = [headers, ...rows.map((row) => headers.map((h) => row[h]))];
  const colWidths = headers.map((h, i) => Math.min(42, Math.max(12, ...allRows.map((r) => String(r[i] ?? "").length + 2))));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${allRows.map((row, rIdx) => `<row r="${rIdx + 1}">${row.map((cell, cIdx) => `<c r="${String.fromCharCode(65 + cIdx)}${rIdx + 1}" t="inlineStr"><is><t>${xlsxEscape(cell ?? "")}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
}

function sendXlsx(res, filename, sheets) {
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xlsxEscape(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }))
  ];
  const body = zipStore(files);
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": body.length
  });
  res.end(body);
}

function storeNameExpr(alias = "s") {
  return `COALESCE(${alias}.store_name, '')`;
}

function memberReportRows(storeId = null) {
  const where = storeId ? "WHERE m.store_id = ?" : "";
  const params = storeId ? [storeId] : [];
  return db.prepare(`
    SELECT m.member_code AS 會員編號, m.name AS 會員姓名, m.phone AS 手機, m.email AS Email,
      ${storeNameExpr("s")} AS 原註冊分店,
      COALESCE(SUM(CASE WHEN pt.type='purchase' AND pt.status='completed' THEN pt.points ELSE 0 END),0) AS 購買點數,
      COALESCE(SUM(CASE WHEN pt.type='gift' AND pt.status='completed' THEN pt.points ELSE 0 END),0) AS 贈予點數,
      COALESCE(SUM(CASE WHEN pt.type='consume' AND pt.status='completed' THEN pt.points ELSE 0 END),0) AS 已消費點數,
      COALESCE(SUM(CASE WHEN pt.type IN ('purchase','gift') AND pt.status='completed' THEN pt.points WHEN pt.type='consume' AND pt.status='completed' THEN -pt.points ELSE 0 END),0) AS 剩餘點數,
      m.created_at AS 建立時間
    FROM members m
    JOIN stores s ON s.id = m.store_id
    LEFT JOIN point_transactions pt ON pt.member_id = m.id
    ${where}
    GROUP BY m.id
    ORDER BY m.id DESC
  `).all(...params);
}

function storeReportRows() {
  return db.prepare(`
    SELECT s.id AS 分店ID, s.store_name AS 分店名稱, s.contact_name AS 聯絡人, s.phone AS 電話, s.email AS Email,
      s.platform_slug AS 專屬代碼, COUNT(m.id) AS 會員數, s.created_at AS 建立時間
    FROM stores s LEFT JOIN members m ON m.store_id = s.id
    GROUP BY s.id ORDER BY s.id DESC
  `).all();
}

function transactionReportRows(storeId = null) {
  const where = storeId ? "WHERE pt.store_id = ?" : "";
  const params = storeId ? [storeId] : [];
  return db.prepare(`
    SELECT pt.id, pt.created_at AS 交易時間, m.id AS member_id, m.member_code AS 會員編號, m.name AS 會員姓名, m.email AS 會員Email,
      reg.store_name AS 原註冊分店, spend.store_name AS 消費分店, pt.type AS 交易類型, pt.points AS 點數, pt.description AS 備註
      ,(
        SELECT COALESCE(SUM(CASE WHEN prior.type IN ('purchase','gift') THEN prior.points WHEN prior.type='consume' THEN -prior.points ELSE 0 END),0)
        FROM point_transactions prior
        WHERE prior.member_id = pt.member_id AND prior.status = 'completed' AND prior.id <= pt.id
      ) AS 交易後餘額
    FROM point_transactions pt
    JOIN members m ON m.id = pt.member_id
    JOIN stores reg ON reg.id = m.store_id
    JOIN stores spend ON spend.id = pt.store_id
    ${where}
    ORDER BY pt.id DESC
  `).all(...params).map((row) => ({
      交易時間: row.交易時間,
      會員編號: row.會員編號,
      會員姓名: row.會員姓名,
      會員Email: row.會員Email,
      原註冊分店: row.原註冊分店,
      消費分店: row.消費分店,
      交易類型: zhType[row.交易類型] || row.交易類型,
      點數: row.點數,
      交易後餘額: row.交易後餘額,
      備註: row.備註 || ""
    }));
}

function requestReportRows(storeId = null) {
  const where = storeId ? "WHERE dr.store_id = ?" : "";
  const params = storeId ? [storeId] : [];
  return db.prepare(`
    SELECT dr.created_at AS 申請時間, m.member_code AS 會員編號, m.name AS 會員姓名, reg.store_name AS 原註冊分店,
      spend.store_name AS 消費分店, dr.points AS 扣點點數, dr.status AS 狀態, dr.approved_at AS 會員核准時間, dr.description AS 備註
    FROM deduction_requests dr
    JOIN members m ON m.id = dr.member_id
    JOIN stores reg ON reg.id = m.store_id
    JOIN stores spend ON spend.id = dr.store_id
    ${where}
    ORDER BY dr.id DESC
  `).all(...params).map((r) => ({ ...r, 狀態: zhStatus[r.狀態] || r.狀態 }));
}

function monthlyReportRows(storeId = null) {
  const where = storeId ? "WHERE store_id = ?" : "";
  const params = storeId ? [storeId] : [];
  return db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS 月份,
      COALESCE(SUM(CASE WHEN type='purchase' THEN points ELSE 0 END),0) AS 購買點數,
      COALESCE(SUM(CASE WHEN type='gift' THEN points ELSE 0 END),0) AS 贈予點數,
      COALESCE(SUM(CASE WHEN type='consume' THEN points ELSE 0 END),0) AS 消費點數
    FROM point_transactions
    ${where}
    GROUP BY strftime('%Y-%m', created_at)
    ORDER BY 月份 DESC
  `).all(...params).map((r) => ({ ...r, 結餘變動: r.購買點數 + r.贈予點數 - r.消費點數 }));
}

function adminUserRows() {
  return db.prepare(`
    SELECT u.id AS 帳號ID, u.role AS 角色, u.name AS 姓名, u.email AS Email, u.phone AS 手機,
      COALESCE(s.store_name, '') AS 所屬分店, u.status AS 狀態, u.is_super_admin AS 總部專職, u.created_at AS 建立時間
    FROM users u LEFT JOIN stores s ON s.id = u.store_id
    WHERE u.role IN ('admin','store')
    ORDER BY u.role, u.id DESC
  `).all();
}

function adminRequestRows() {
  return db.prepare(`
    SELECT ar.created_at AS 申請時間, ar.name AS 姓名, ar.email AS Email, ar.phone AS 手機, ar.role AS 角色,
      COALESCE(s.store_name, '') AS 所屬分店, ar.status AS 狀態, requester.name AS 申請人,
      reviewer.name AS 審核人, ar.reviewed_at AS 審核時間, ar.disabled_at AS 停用時間
    FROM admin_account_requests ar
    LEFT JOIN stores s ON s.id = ar.store_id
    LEFT JOIN users requester ON requester.id = ar.requested_by
    LEFT JOIN users reviewer ON reviewer.id = ar.reviewed_by
    ORDER BY ar.id DESC
  `).all();
}

function adminAuditRows() {
  return db.prepare(`
    SELECT event_at AS 事件時間, event_type AS 事件, login_email AS 登入Email, admin_name AS 管理員姓名,
      ip AS 登入IP, user_agent AS UserAgent, result AS 結果, failure_reason AS 失敗原因, user_id AS 操作者ID, created_at AS 建立時間
    FROM admin_audit_logs ORDER BY id DESC
  `).all();
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
    <div class="field"><label>初始密碼</label><input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></div>
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

function adminMembers(req, res, user) {
  const rows = db.prepare(`
    SELECT m.member_code, m.name, m.email, m.phone, s.store_name,
      COALESCE(SUM(CASE WHEN pt.type = 'purchase' AND pt.status = 'completed' THEN pt.points ELSE 0 END), 0) AS purchase_points,
      COALESCE(SUM(CASE WHEN pt.type = 'gift' AND pt.status = 'completed' THEN pt.points ELSE 0 END), 0) AS gift_points,
      COALESCE(SUM(CASE WHEN pt.type = 'consume' AND pt.status = 'completed' THEN pt.points ELSE 0 END), 0) AS consume_points
    FROM members m
    LEFT JOIN stores s ON s.id = m.store_id
    LEFT JOIN point_transactions pt ON pt.member_id = m.id
    GROUP BY m.id
    ORDER BY m.id DESC
  `).all();
  const table = rows.length ? `<table class="table"><thead><tr><th>會員編號</th><th>會員</th><th>電話</th><th>所屬分店</th><th>購買</th><th>贈予</th><th>剩餘</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td>${escapeHtml(m.member_code || "")}</td><td>${escapeHtml(m.name)}<br><span class="muted">${escapeHtml(m.email)}</span></td><td>${escapeHtml(m.phone)}</td><td>${escapeHtml(m.store_name || "")}</td><td>${money(m.purchase_points)}</td><td>${money(m.gift_points)}</td><td>${money(m.purchase_points + m.gift_points - m.consume_points)}</td></tr>
  `).join("")}</tbody></table>` : `<div class="empty">尚無會員。</div>`;
  send(res, 200, page("會員列表", table, user));
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
    <div class="field"><label>初始密碼</label><input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></div>
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
  const table = rows.length ? `<table class="table"><thead><tr><th>會員編號</th><th>會員</th><th>電話</th><th>購買</th><th>贈予</th><th>剩餘</th><th>操作</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td>${escapeHtml(m.member_code || "")}</td><td>${escapeHtml(m.name)}<br><span class="muted">${escapeHtml(m.email)}</span></td><td>${escapeHtml(m.phone)}</td><td>${money(m.purchase_points)}</td><td>${money(m.gift_points)}</td><td>${money(m.purchase_points + m.gift_points - m.consume_points)}</td><td><a class="button secondary" href="/store/members/${m.id}">詳細</a></td></tr>
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
      <div class="panel"><h2>${escapeHtml(member.name)}</h2><p>會員編號：<b>${escapeHtml(member.member_code || "")}</b></p><p>${escapeHtml(member.phone)}｜${escapeHtml(member.email)}</p><h3>消費與點數紀錄</h3>${renderTransactions(tx)}</div>
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
    SELECT dr.*, m.member_code, m.name AS member_name, m.email AS member_email, reg.store_name AS registered_store
    FROM deduction_requests dr
    JOIN members m ON m.id = dr.member_id
    JOIN stores reg ON reg.id = m.store_id
    WHERE dr.store_id = ?
    ORDER BY dr.id DESC
  `).all(user.store_id);
  const table = rows.length ? `<table class="table"><thead><tr><th>會員編號</th><th>會員</th><th>原註冊分店</th><th>點數</th><th>狀態</th><th>說明</th><th>建立時間</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td>${escapeHtml(r.member_code || "")}</td><td>${escapeHtml(r.member_name)}<br><span class="muted">${escapeHtml(r.member_email)}</span></td><td>${escapeHtml(r.registered_store)}</td><td>${money(r.points)}</td><td><span class="badge">${zhStatus[r.status]}</span></td><td>${escapeHtml(r.description || "")}</td><td>${escapeHtml(r.created_at)}</td></tr>
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
  send(res, 200, page("我的點數總覽", `<div class="panel" style="margin-bottom:16px"><b>會員編號：</b>${escapeHtml(member.member_code || "")}</div>${renderStatsCards(stats)}
    <div class="grid split" style="margin-top:16px">
      <div class="panel"><h2>待核准扣點要求</h2>${pendingHtml}</div>
      <div class="panel"><h2>點數與消費紀錄</h2>${renderTransactions(tx)}</div>
    </div>`, user));
}

function memberShareCenter(req, res, user) {
  const member = db.prepare("SELECT * FROM members WHERE user_id = ?").get(user.id);
  if (!member) return send(res, 404, page("找不到會員資料", `<div class="empty">此帳號尚未連結會員資料。</div>`, user));
  const memberCode = member.member_code || "";
  const url = new URL(req.url, `http://${req.headers.host}`);
  const productCode = String(url.searchParams.get("product") || "").trim().toUpperCase();
  const product = productCode ? db.prepare(`
    SELECT p.*, pt.name AS type_name, pc.name AS category_name
    FROM products p
    JOIN product_types pt ON pt.id = p.type_id
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    WHERE p.product_code = ? AND p.is_active = 1
  `).get(productCode) : null;
  if (productCode && !product) {
    return send(res, 404, page("找不到商品", `<div class="empty">找不到此商品，或商品尚未上架。</div><p><a class="button" href="/member/mall">返回商城</a></p>`, user));
  }
  const shareUrl = product
    ? `https://tally.so/r/RGlpAl?product=${encodeURIComponent(product.product_code)}&ref=${encodeURIComponent(memberCode)}`
    : `https://tally.so/r/RGlpAl?ref=${encodeURIComponent(memberCode)}`;
  send(res, 200, page("我的成交中心", `<div class="panel">
    <p class="muted">分享您的專屬連結，系統將自動記錄推薦來源。</p>
    ${product ? `<div class="panel" style="margin:0 0 16px 0;background:#fbfaf7">
      <h2 style="margin-top:0">${escapeHtml(product.name)}</h2>
      <p class="muted">商品編號：${escapeHtml(product.product_code)}｜${escapeHtml(product.type_name)}${product.category_name ? ` → ${escapeHtml(product.category_name)}` : ""}</p>
      <p>${escapeHtml(product.short_description || "")}</p>
      <p><a class="button secondary" href="${escapeHtml(product.product_page_url)}" target="_blank" rel="noopener noreferrer">查看商品介紹</a></p>
    </div>` : ""}
    <div class="field"><label>會員編號</label><input value="${escapeHtml(memberCode)}" readonly></div>
    <div class="field" style="margin-top:14px"><label>完整分享網址</label><input id="share-url" value="${escapeHtml(shareUrl)}" readonly></div>
    <div class="actions" style="margin-top:16px">
      <button class="button" type="button" onclick="copyShareUrl()">複製網址</button>
      <button class="button secondary" type="button" onclick="shareToLine()">LINE 分享</button>
      <button class="button secondary" type="button" onclick="shareToFacebook()">Facebook 分享</button>
      <button class="button secondary" type="button" onclick="downloadQrCode()">下載 QRCode（PNG）</button>
      <span id="copy-message" class="muted" role="status" style="align-self:center"></span>
    </div>
    <div style="margin-top:20px;display:grid;gap:10px;justify-items:start">
      <canvas id="share-qrcode" width="244" height="244" style="width:244px;height:244px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px"></canvas>
      <span class="muted">QRCode 內容：${escapeHtml(shareUrl)}</span>
    </div>
  </div>
  <script>
    const shareUrl = document.getElementById("share-url").value;

    async function copyShareUrl() {
      const input = document.getElementById("share-url");
      const message = document.getElementById("copy-message");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch (error) {
        input.select();
        document.execCommand("copy");
      }
      message.textContent = "分享網址已複製";
    }

    function shareToLine() {
      const text = "推薦您了解 LT 大健康成交平台\\n" + shareUrl;
      window.open("https://line.me/R/msg/text/?" + encodeURIComponent(text), "_blank", "noopener,noreferrer");
    }

    function shareToFacebook() {
      window.open("https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(shareUrl), "_blank", "noopener,noreferrer");
    }

    function downloadQrCode() {
      const link = document.createElement("a");
      link.download = "lt-share-qrcode.png";
      link.href = document.getElementById("share-qrcode").toDataURL("image/png");
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    function drawQrCode(text) {
      const qr = createQrMatrix(text);
      const canvas = document.getElementById("share-qrcode");
      const ctx = canvas.getContext("2d");
      const quiet = 4;
      const cells = qr.length + quiet * 2;
      const scale = Math.floor(canvas.width / cells);
      const offset = Math.floor((canvas.width - cells * scale) / 2);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#19362f";
      for (let y = 0; y < qr.length; y++) {
        for (let x = 0; x < qr.length; x++) {
          if (qr[y][x]) ctx.fillRect(offset + (x + quiet) * scale, offset + (y + quiet) * scale, scale, scale);
        }
      }
    }

    function createQrMatrix(text) {
      const version = 4;
      const size = 17 + version * 4;
      const dataCodewords = 80;
      const ecCodewords = 20;
      const modules = Array.from({ length: size }, () => Array(size).fill(false));
      const reserved = Array.from({ length: size }, () => Array(size).fill(false));

      function setModule(x, y, dark, reserve = true) {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        modules[y][x] = dark;
        if (reserve) reserved[y][x] = true;
      }

      function addFinder(x, y) {
        for (let dy = -1; dy <= 7; dy++) {
          for (let dx = -1; dx <= 7; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
            setModule(xx, yy, dark);
          }
        }
      }

      addFinder(0, 0);
      addFinder(size - 7, 0);
      addFinder(0, size - 7);
      for (let i = 8; i < size - 8; i++) {
        setModule(i, 6, i % 2 === 0);
        setModule(6, i, i % 2 === 0);
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setModule(26 + dx, 26 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
      setModule(8, size - 8, true);
      reserveFormatAreas(reserved, size);

      const data = makeDataCodewords(text, dataCodewords);
      const bytes = data.concat(reedSolomonRemainder(data, ecCodewords));
      const bits = [];
      for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push(((byte >>> i) & 1) === 1);

      let bitIndex = 0;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right--;
        for (let vert = 0; vert < size; vert++) {
          const y = upward ? size - 1 - vert : vert;
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            if (reserved[y][x]) continue;
            const bit = bitIndex < bits.length ? bits[bitIndex++] : false;
            setModule(x, y, bit !== ((x + y) % 2 === 0), false);
          }
        }
        upward = !upward;
      }

      drawFormatBits(modules, 0);
      return modules;
    }

    function reserveFormatAreas(reserved, size) {
      for (let i = 0; i < 9; i++) {
        reserved[8][i] = true;
        reserved[i][8] = true;
      }
      for (let i = 0; i < 8; i++) {
        reserved[8][size - 1 - i] = true;
        reserved[size - 1 - i][8] = true;
      }
    }

    function drawFormatBits(modules, mask) {
      const size = modules.length;
      let data = (1 << 3) | mask;
      let bits = data << 10;
      for (let i = 14; i >= 10; i--) {
        if (((bits >>> i) & 1) !== 0) bits ^= 0x537 << (i - 10);
      }
      bits = ((data << 10) | bits) ^ 0x5412;
      const first = [[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]];
      const second = [[8,size-1],[8,size-2],[8,size-3],[8,size-4],[8,size-5],[8,size-6],[8,size-7],[8,size-8],[size-7,8],[size-6,8],[size-5,8],[size-4,8],[size-3,8],[size-2,8],[size-1,8]];
      for (let i = 0; i < 15; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        modules[first[i][1]][first[i][0]] = dark;
        modules[second[i][1]][second[i][0]] = dark;
      }
    }

    function makeDataCodewords(text, capacity) {
      const bytes = Array.from(new TextEncoder().encode(text));
      if (bytes.length > 78) throw new Error("分享網址過長，無法產生 QRCode。");
      const bits = [0,1,0,0];
      for (let i = 7; i >= 0; i--) bits.push(((bytes.length >>> i) & 1) === 1);
      for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push(((byte >>> i) & 1) === 1);
      const maxBits = capacity * 8;
      for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(false);
      while (bits.length % 8 !== 0) bits.push(false);
      const result = [];
      for (let i = 0; i < bits.length; i += 8) result.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | (bit ? 1 : 0), 0));
      for (let pad = 0; result.length < capacity; pad++) result.push(pad % 2 === 0 ? 0xec : 0x11);
      return result;
    }

    function reedSolomonRemainder(data, degree) {
      const generator = rsGenerator(degree);
      const result = Array(degree).fill(0);
      for (const byte of data) {
        const factor = byte ^ result.shift();
        result.push(0);
        for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(generator[i], factor);
      }
      return result;
    }

    function rsGenerator(degree) {
      let result = [1];
      for (let i = 0; i < degree; i++) {
        const next = Array(result.length + 1).fill(0);
        for (let j = 0; j < result.length; j++) {
          next[j] ^= gfMultiply(result[j], 1);
          next[j + 1] ^= gfMultiply(result[j], gfPow(2, i));
        }
        result = next;
      }
      return result.slice(1);
    }

    function gfPow(x, power) {
      let result = 1;
      for (let i = 0; i < power; i++) result = gfMultiply(result, x);
      return result;
    }

    function gfMultiply(x, y) {
      let result = 0;
      for (let i = 7; i >= 0; i--) {
        result = (result << 1) ^ ((result >>> 7) * 0x11d);
        if (((y >>> i) & 1) !== 0) result ^= x;
      }
      return result & 0xff;
    }

    drawQrCode(shareUrl);
  </script>`, user));
}

function mediaCardHtml(asset, { selectable = false } = {}) {
  const title = asset.display_name || asset.original_filename || `媒體 #${asset.id}`;
  return `<article class="card" style="display:grid;gap:10px">
    <div style="position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;border-radius:8px;background:var(--jade);border:1px solid var(--line)">
      <img src="${escapeHtml(cloudinaryOptimizedUrl(asset.secure_url, 420))}" alt="${escapeHtml(asset.alt_text || title)}" loading="lazy" onerror="this.hidden=true" style="width:100%;height:100%;object-fit:cover">
    </div>
    <div>
      <b>${escapeHtml(title)}</b>
      <div class="muted" style="font-size:13px">${escapeHtml(asset.original_filename || "")}</div>
      <div class="muted" style="font-size:13px">${asset.width || "-"} × ${asset.height || "-"}｜${formatBytes(asset.file_size)}</div>
      <div class="muted" style="font-size:13px">${escapeHtml(asset.created_at || "")}</div>
    </div>
    <div class="actions">
      <button class="button secondary" type="button" data-copy-url="${escapeHtml(asset.secure_url)}">複製圖片網址</button>
      ${selectable ? `<a class="button" href="/admin/mall?media=${asset.id}">套用到商品</a>` : ""}
    </div>
  </article>`;
}

function mediaLibraryHtml({ selectable = false, limit = 24 } = {}) {
  const assets = mediaAssets(limit);
  if (!assets.length) return `<div class="empty">尚未上傳圖片。</div>`;
  return `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">${assets.map((asset) => mediaCardHtml(asset, { selectable })).join("")}</div>
    <script>
      document.querySelectorAll("[data-copy-url]").forEach((button) => {
        button.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(button.dataset.copyUrl);
            button.textContent = "已複製";
          } catch {
            button.textContent = "請手動複製";
          }
        });
      });
    </script>`;
}

function adminMediaPage(req, res, user, message = "") {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const notice = message || url.searchParams.get("message") || "";
  const configured = isCloudinaryConfigured();
  send(res, 200, page("媒體中心", `${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    ${configured ? "" : `<div class="notice">媒體上傳尚未設定。請在 Render Environment 設定 Cloudinary 環境變數後再上傳圖片。</div>`}
    <div class="grid split">
      <section class="panel">
        <h2>上傳圖片</h2>
        <form class="stack" method="post" action="/admin/media/upload" enctype="multipart/form-data">
          <div class="field"><label>選擇圖片</label><input name="image" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" required></div>
          <div class="field"><label>圖片名稱</label><input name="display_name" placeholder="可選填"></div>
          <div class="field"><label>替代文字 alt text</label><input name="alt_text" placeholder="可選填"></div>
          <span class="muted">支援 JPG、PNG、WebP，單張圖片 5 MB 以下；建議使用 1200 × 1200 px。</span>
          <button class="button" ${configured ? "" : "disabled"}>上傳圖片</button>
        </form>
      </section>
      <section class="panel">
        <h2>資料庫變更摘要</h2>
        <p class="muted">新增 media_assets 保存 Cloudinary 圖片資料；products 保留 image_url，另新增可為空的 media_asset_id。</p>
      </section>
    </div>
    <section class="panel" style="margin-top:16px">
      <h2>媒體庫</h2>
      ${mediaLibraryHtml({ selectable: true, limit: 60 })}
    </section>`, user));
}

function productRows(activeOnly = false) {
  return db.prepare(`
    SELECT p.*, ma.secure_url AS media_secure_url, ma.alt_text AS media_alt_text,
      pt.name AS type_name, pt.sort_order AS type_sort, pc.name AS category_name, pc.sort_order AS category_sort
    FROM products p
    LEFT JOIN media_assets ma ON ma.id = p.media_asset_id AND ma.is_active = 1
    JOIN product_types pt ON pt.id = p.type_id
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    WHERE (? = 0 OR (p.is_active = 1 AND pt.is_active = 1 AND (pc.id IS NULL OR pc.is_active = 1)))
    ORDER BY pt.sort_order, pt.id, COALESCE(pc.sort_order, 9999), COALESCE(pc.id, 0), p.sort_order, p.id
  `).all(activeOnly ? 1 : 0);
}

function mallCatalogHtml(user, { admin = false } = {}) {
  const rows = productRows(!admin);
  if (!rows.length) return `<div class="empty">目前沒有上架商品。</div>`;
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.type_name)) grouped.set(row.type_name, new Map());
    const category = row.category_name || "未分類";
    if (!grouped.get(row.type_name).has(category)) grouped.get(row.type_name).set(category, []);
    grouped.get(row.type_name).get(category).push(row);
  }
  return [...grouped.entries()].map(([typeName, categories]) => `
    <section class="panel" style="margin-bottom:16px">
      <h2 style="margin-top:0">${escapeHtml(typeName)}</h2>
      ${[...categories.entries()].map(([categoryName, products]) => `
        <div style="margin-top:14px">
          <h3 style="margin:0 0 10px">${escapeHtml(categoryName)}</h3>
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
            ${products.map((product) => productCardHtml(product, user, admin)).join("")}
          </div>
        </div>
      `).join("")}
    </section>
  `).join("");
}

function productCardHtml(product, user, admin = false) {
  const fallbackImage = `<div style="position:absolute;inset:0;border:1px solid var(--line);border-radius:8px;background:var(--jade);display:flex;align-items:center;justify-content:center;text-align:center;color:var(--deep);padding:18px"><div><b style="display:block;font-size:18px;margin-bottom:8px">LT 商品</b><strong style="display:block;font-size:20px;line-height:1.35">${escapeHtml(product.name)}</strong><span class="muted" style="display:block;margin-top:8px">${escapeHtml(product.product_code)}</span><span class="badge" style="margin-top:12px">圖片待補</span></div></div>`;
  const imageUrl = product.media_secure_url || product.image_url || "";
  const image = imageUrl
    ? `<div style="position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;border-radius:8px">${fallbackImage}<img src="${escapeHtml(cloudinaryOptimizedUrl(imageUrl))}" alt="${escapeHtml(product.media_alt_text || product.name)}" onerror="this.hidden=true" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border:1px solid var(--line);border-radius:8px;background:#fff"></div>`
    : `<div style="position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;border-radius:8px">${fallbackImage}</div>`;
  const shareAction = user.role === "member"
    ? `<a class="button" href="/member/share-center?product=${encodeURIComponent(product.product_code)}">取得分享工具</a>`
    : user.role === "store"
      ? `<span class="muted" style="align-self:center">會員登入後可取得個人分享工具</span>`
      : "";
  return `<article class="card" style="display:grid;gap:12px">
    ${image}
    <div>
      <h3 style="margin:0 0 6px">${escapeHtml(product.name)}</h3>
      <div class="muted">${escapeHtml(product.product_code)}｜${escapeHtml(product.type_name)}${product.category_name ? ` → ${escapeHtml(product.category_name)}` : ""}</div>
    </div>
    <p style="margin:0">${escapeHtml(product.short_description || "")}</p>
    <b>${priceLabel(product.price, product.currency)}</b>
    ${admin ? `<span class="badge">${product.is_active ? "上架" : "下架"}</span>` : ""}
    <div class="actions">
      <a class="button secondary" href="${escapeHtml(product.product_page_url)}" target="_blank" rel="noopener noreferrer">查看商品</a>
      ${shareAction}
      ${admin ? `<a class="button secondary" href="/admin/mall?edit=${encodeURIComponent(product.product_code)}">修改</a>
        <form method="post" action="/admin/mall/products/${product.id}/toggle"><button class="button secondary">${product.is_active ? "下架" : "上架"}</button></form>` : ""}
    </div>
  </article>`;
}

function typeOptions(selected = "") {
  return db.prepare("SELECT * FROM product_types ORDER BY sort_order, id").all()
    .map((type) => `<option value="${type.id}" ${String(selected) === String(type.id) ? "selected" : ""}>${escapeHtml(type.name)}</option>`).join("");
}

function categoryOptions(selected = "", typeId = "") {
  const rows = typeId
    ? db.prepare("SELECT * FROM product_categories WHERE type_id = ? ORDER BY sort_order, id").all(typeId)
    : db.prepare("SELECT pc.*, pt.name AS type_name FROM product_categories pc JOIN product_types pt ON pt.id = pc.type_id ORDER BY pt.sort_order, pt.id, pc.sort_order, pc.id").all();
  return `<option value="">未分類</option>${rows.map((category) => `<option value="${category.id}" ${String(selected || "") === String(category.id) ? "selected" : ""}>${escapeHtml(category.type_name ? `${category.type_name} / ${category.name}` : category.name)}</option>`).join("")}`;
}

function productMediaPickerHtml(productValues) {
  const selectedId = String(productValues.media_asset_id || "");
  const assets = mediaAssets(12);
  const cards = assets.length ? assets.map((asset) => {
    const checked = selectedId && selectedId === String(asset.id);
    const title = asset.display_name || asset.original_filename || `媒體 #${asset.id}`;
    return `<label class="card" style="display:grid;gap:8px;padding:10px;cursor:pointer">
      <input type="radio" name="media_asset_id" value="${asset.id}" data-media-url="${escapeHtml(asset.secure_url)}" ${checked ? "checked" : ""}>
      <img src="${escapeHtml(cloudinaryOptimizedUrl(asset.secure_url, 240))}" alt="${escapeHtml(asset.alt_text || title)}" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;border:1px solid var(--line)">
      <span style="font-weight:700">${escapeHtml(title)}</span>
    </label>`;
  }).join("") : `<div class="empty">媒體中心尚未有圖片。</div>`;
  return `<div class="field">
    <label>從媒體中心選擇</label>
    <label class="actions" style="align-items:center"><input type="radio" name="media_asset_id" value="" ${selectedId ? "" : "checked"}> 使用下方商品圖片網址</label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">${cards}</div>
    <a class="button secondary" href="/admin/media">前往媒體中心</a>
  </div>
  <script>
    document.querySelectorAll("input[name='media_asset_id'][data-media-url]").forEach((radio) => {
      radio.addEventListener("change", () => {
        const input = document.querySelector("input[name='image_url']");
        if (radio.checked && input) input.value = radio.dataset.mediaUrl;
      });
    });
  </script>`;
}

function productDirectUploadHtml(editProduct, selectedMediaId = "") {
  const configured = isCloudinaryConfigured();
  return `<section class="panel" style="margin-top:16px">
    <h2>直接上傳新圖片</h2>
    ${configured ? "" : `<div class="notice">媒體上傳尚未設定。請先在 Render Environment 設定 Cloudinary 環境變數。</div>`}
    <form class="stack" method="post" action="/admin/media/upload" enctype="multipart/form-data">
      <input type="hidden" name="context" value="mall">
      <input type="hidden" name="product_id" value="${escapeHtml(editProduct?.id || "")}">
      <input type="hidden" name="return_edit" value="${escapeHtml(editProduct?.product_code || "")}">
      <input type="hidden" name="selected_media_id" value="${escapeHtml(selectedMediaId || "")}">
      <div class="field"><label>選擇圖片</label><input name="image" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" required></div>
      <div class="field"><label>圖片名稱</label><input name="display_name" value="${escapeHtml(editProduct?.name || "")}" placeholder="可選填"></div>
      <div class="field"><label>替代文字 alt text</label><input name="alt_text" value="${escapeHtml(editProduct?.name || "")}" placeholder="可選填"></div>
      <span class="muted">支援 JPG、PNG、WebP，單張圖片 5 MB 以下；建議使用 1200 × 1200 px。</span>
      <button class="button" ${configured ? "" : "disabled"}>${editProduct ? "上傳並套用到此商品" : "上傳並帶回商品表單"}</button>
    </form>
  </section>`;
}

function adminMallPage(req, res, user, error = "", values = {}) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const editCode = String(url.searchParams.get("edit") || "").trim().toUpperCase();
  const editProduct = editCode ? db.prepare("SELECT * FROM products WHERE product_code = ?").get(editCode) : null;
  const selectedMedia = mediaAssetById(url.searchParams.get("media"));
  const productValues = { ...(editProduct || {}), ...(selectedMedia ? { media_asset_id: selectedMedia.id, image_url: selectedMedia.secure_url } : {}), ...values };
  const notice = error || url.searchParams.get("message") || "";
  const productFormTitle = editProduct ? `修改商品：${escapeHtml(editProduct.product_code)}` : "新增商品";
  const typeRows = db.prepare("SELECT * FROM product_types ORDER BY sort_order, id").all();
  const categoryRows = db.prepare(`
    SELECT pc.*, pt.name AS type_name
    FROM product_categories pc JOIN product_types pt ON pt.id = pc.type_id
    ORDER BY pt.sort_order, pt.id, pc.sort_order, pc.id
  `).all();
  send(res, 200, page("商城", `${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    <div class="grid split">
      <div class="panel">
        <h2>商品類型</h2>
        ${typeRows.length ? `<table class="table"><thead><tr><th>名稱</th><th>排序</th><th>狀態</th></tr></thead><tbody>${typeRows.map((type) => `<tr><td>${escapeHtml(type.name)}</td><td>${type.sort_order}</td><td>${type.is_active ? "啟用" : "停用"}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">尚無商品類型。</div>`}
        <form class="stack" method="post" action="/admin/mall/types" style="margin-top:14px">
          <div class="field"><label>新增商品類型</label><input name="name" required></div>
          <div class="field"><label>顯示順序</label><input name="sort_order" type="number" value="0"></div>
          <button class="button">新增類型</button>
        </form>
      </div>
      <div class="panel">
        <h2>商品分類</h2>
        ${categoryRows.length ? `<table class="table"><thead><tr><th>類型</th><th>分類</th><th>排序</th><th>狀態</th></tr></thead><tbody>${categoryRows.map((category) => `<tr><td>${escapeHtml(category.type_name)}</td><td>${escapeHtml(category.name)}</td><td>${category.sort_order}</td><td>${category.is_active ? "啟用" : "停用"}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">尚無商品分類。</div>`}
        <form class="stack" method="post" action="/admin/mall/categories" style="margin-top:14px">
          <div class="field"><label>商品類型</label><select name="type_id" required>${typeOptions()}</select></div>
          <div class="field"><label>新增商品分類</label><input name="name" required></div>
          <div class="field"><label>顯示順序</label><input name="sort_order" type="number" value="0"></div>
          <button class="button">新增分類</button>
        </form>
      </div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2>${productFormTitle}</h2>
      <form class="stack" method="post" action="/admin/mall/products">
        <input type="hidden" name="id" value="${escapeHtml(productValues.id || "")}">
        <div class="field"><label>商品編號</label><input name="product_code" value="${escapeHtml(productValues.product_code || "")}" required></div>
        <div class="field"><label>商品名稱</label><input name="name" value="${escapeHtml(productValues.name || "")}" required></div>
        <div class="field"><label>商品類型</label><select name="type_id" required>${typeOptions(productValues.type_id)}</select></div>
        <div class="field"><label>商品分類</label><select name="category_id">${categoryOptions(productValues.category_id)}</select></div>
        <div class="field"><label>簡短介紹</label><textarea name="short_description">${escapeHtml(productValues.short_description || "")}</textarea></div>
        <div class="field"><label>商品圖片網址</label><input name="image_url" value="${escapeHtml(productValues.image_url || "")}" placeholder="https://"><span class="muted">請填入可直接顯示的 JPG、PNG 或 WebP 圖片網址，不可填入一般網頁或 Canva 頁面網址。</span></div>
        ${productMediaPickerHtml(productValues)}
        <div class="field"><label>商品介紹網址</label><input name="product_page_url" value="${escapeHtml(productValues.product_page_url || "")}" placeholder="https://" required></div>
        <div class="field"><label>價格</label><input name="price" type="number" min="0" step="1" value="${productValues.price ?? ""}" placeholder="留空顯示價格洽詢"></div>
        <div class="field"><label>顯示順序</label><input name="sort_order" type="number" value="${productValues.sort_order ?? 0}"></div>
        <label class="actions" style="align-items:center"><input name="is_active" type="checkbox" value="1" ${String(productValues.is_active ?? 1) === "1" ? "checked" : ""}> 是否上架</label>
        <button class="button">${editProduct ? "儲存商品" : "新增商品"}</button>
      </form>
    </div>
    ${productDirectUploadHtml(editProduct, productValues.media_asset_id)}
    <div style="margin-top:16px">${mallCatalogHtml(user, { admin: true })}</div>`, user));
}

function mallPage(res, user) {
  const title = user.role === "admin" ? "商城" : "商城";
  send(res, 200, page(title, mallCatalogHtml(user), user));
}

function adminReports(req, res, user) {
  send(res, 200, page("報表匯出中心", `<div class="panel"><h2>Excel 總報表</h2><p><a class="button" href="/admin/export/all.xlsx">下載 Excel 總報表</a></p></div>
    <div class="panel" style="margin-top:16px"><h2>CSV 匯出</h2><div class="actions">
      <a class="button secondary" href="/admin/export/stores.csv">分店資料 CSV</a>
      <a class="button secondary" href="/admin/export/members.csv">會員資料 CSV</a>
      <a class="button secondary" href="/admin/export/transactions.csv">交易紀錄 CSV</a>
      <a class="button secondary" href="/admin/export/requests.csv">扣點紀錄 CSV</a>
    </div></div>`, user));
}

function storeReports(req, res, user) {
  send(res, 200, page("報表匯出中心", `<div class="panel"><h2>本分店 Excel 報表</h2><p><a class="button" href="/store/export/all.xlsx">下載本分店 Excel</a></p></div>
    <div class="panel" style="margin-top:16px"><h2>CSV 匯出</h2><div class="actions">
      <a class="button secondary" href="/store/export/members.csv">會員資料 CSV</a>
      <a class="button secondary" href="/store/export/transactions.csv">交易紀錄 CSV</a>
      <a class="button secondary" href="/store/export/requests.csv">扣點紀錄 CSV</a>
    </div></div>`, user));
}

function crossStorePage(req, res, user, query = "", error = "") {
  const q = query.trim();
  const rows = q ? db.prepare(`
    SELECT m.*, s.store_name
    FROM members m JOIN stores s ON s.id = m.store_id
    WHERE m.member_code = ? OR m.name LIKE ? OR m.phone LIKE ? OR m.email LIKE ?
    ORDER BY CASE WHEN m.member_code = ? THEN 0 ELSE 1 END, m.id DESC
    LIMIT 30
  `).all(q, `%${q}%`, `%${q}%`, `%${q}%`, q).map((m) => ({ ...m, stats: memberStats(m.id) })) : [];
  const result = rows.length ? `<table class="table"><thead><tr><th>會員編號</th><th>會員</th><th>手機</th><th>Email</th><th>原註冊分店</th><th>剩餘點數</th><th>扣點申請</th></tr></thead><tbody>${rows.map((m) => `
    <tr><td>${escapeHtml(m.member_code || "")}</td><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.phone)}</td><td>${escapeHtml(m.email)}</td><td>${escapeHtml(m.store_name)}</td><td>${money(m.stats.balance_points)}</td><td>
      <form class="stack" method="post" action="/store/cross-store/deductions" style="max-width:260px">
        <input type="hidden" name="member_id" value="${m.id}">
        <input name="points" type="number" min="1" placeholder="扣點點數" required>
        <input name="description" placeholder="扣點說明" required>
        <button class="button secondary">送出申請</button>
      </form>
    </td></tr>`).join("")}</tbody></table>` : q ? `<div class="empty">查無會員。</div>` : "";
  send(res, 200, page("跨店扣點 / 查找會員", `<div class="panel">${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}<form class="stack" method="get" action="/store/cross-store">
    <div class="field"><label>搜尋會員編號、姓名、手機或 Email</label><input name="q" value="${escapeHtml(q)}" autofocus></div>
    <button class="button">搜尋</button>
  </form></div><div style="margin-top:16px">${result}</div>`, user));
}

function managerRequestForm(user, error = "", values = {}) {
  const stores = db.prepare("SELECT id, store_name FROM stores ORDER BY id").all();
  const roleOptions = user.role === "store" ? `<option value="store">分店管理員</option>` : `<option value="admin">總部管理員</option><option value="store">分店管理員</option>`;
  const storeOptions = stores.map((s) => `<option value="${s.id}" ${String(values.store_id || user.store_id || "") === String(s.id) ? "selected" : ""}>${escapeHtml(s.store_name)}</option>`).join("");
  return `${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}<form class="stack" method="post" action="${user.role === "admin" ? "/admin/manager-requests" : "/store/manager-requests"}">
    <div class="field"><label>姓名</label><input name="name" value="${escapeHtml(values.name || "")}" required></div>
    <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(values.email || "")}" required></div>
    <div class="field"><label>手機</label><input name="phone" value="${escapeHtml(values.phone || "")}"></div>
    <div class="field"><label>角色</label><select name="role">${roleOptions}</select></div>
    <div class="field"><label>所屬分店</label><select name="store_id"><option value="">無</option>${storeOptions}</select></div>
    <button class="button">送出申請</button>
  </form><p class="muted">核准後會產生一次性顯示的隨機臨時密碼，請安全交付給使用者並要求立即修改。</p>`;
}

function managerRequestsPage(res, user, error = "") {
  const rows = db.prepare(`
    SELECT ar.*, s.store_name, requester.name AS requester_name, reviewer.name AS reviewer_name
    FROM admin_account_requests ar
    LEFT JOIN stores s ON s.id = ar.store_id
    LEFT JOIN users requester ON requester.id = ar.requested_by
    LEFT JOIN users reviewer ON reviewer.id = ar.reviewed_by
    ${user.role === "store" ? "WHERE ar.store_id = ?" : ""}
    ORDER BY ar.id DESC
  `).all(...(user.role === "store" ? [user.store_id] : []));
  const table = rows.length ? `<table class="table"><thead><tr><th>申請時間</th><th>姓名</th><th>Email</th><th>角色</th><th>分店</th><th>狀態</th><th>審核</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td>${escapeHtml(r.created_at)}</td><td>${escapeHtml(r.name)}<br><span class="muted">${escapeHtml(r.phone || "")}</span></td><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.role)}</td><td>${escapeHtml(r.store_name || "")}</td><td><span class="badge">${escapeHtml(r.status)}</span></td><td>${isSuperAdmin(user) && r.status === "pending" ? `<form class="actions" method="post" action="/admin/manager-requests/${r.id}/review"><button class="button" name="decision" value="approved">核准</button><button class="button danger" name="decision" value="rejected">拒絕</button></form>` : ""}</td></tr>
  `).join("")}</tbody></table>` : `<div class="empty">尚無申請紀錄。</div>`;
  const users = user.role === "admin" ? adminUserRows() : adminUserRows().filter((u) => u.角色 === "store" && u.所屬分店 === storeForUser(user)?.store_name);
  const userTable = `<table class="table"><thead><tr><th>ID</th><th>角色</th><th>姓名</th><th>Email</th><th>分店</th><th>狀態</th><th>操作</th></tr></thead><tbody>${users.map((u) => `
    <tr><td>${u.帳號ID}</td><td>${escapeHtml(u.角色)}</td><td>${escapeHtml(u.姓名)}</td><td>${escapeHtml(u.Email)}</td><td>${escapeHtml(u.所屬分店)}</td><td>${escapeHtml(u.狀態)}</td><td>${isSuperAdmin(user) && u.總部專職 !== 1 ? `<form method="post" action="/admin/users/${u.帳號ID}/status"><button class="button secondary" name="status" value="${u.狀態 === "active" ? "disabled" : "active"}">${u.狀態 === "active" ? "停用" : "恢復"}</button></form>` : ""}</td></tr>
  `).join("")}</tbody></table>`;
  send(res, 200, page("管理員帳號申請 / 核准", `<div class="grid split"><div class="panel"><h2>提出申請</h2>${managerRequestForm(user, error)}</div><div class="panel"><h2>管理員帳號</h2>${userTable}</div></div><div class="panel" style="margin-top:16px"><h2>申請紀錄</h2>${table}</div>`, user));
}

function adminAuditPage(res, user) {
  if (!isSuperAdmin(user)) return send(res, 403, page("無權限", `<div class="empty">只有總部專職管理員可查看操作紀錄。</div>`, user));
  const rows = adminAuditRows();
  const table = rows.length ? `<table class="table"><thead><tr>${Object.keys(rows[0]).map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${Object.keys(r).map((h) => `<td>${escapeHtml(r[h] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<div class="empty">尚無操作紀錄。</div>`;
  send(res, 200, page("總部管理員操作紀錄", table, user));
}

function handleExport(req, res, pathname) {
  if (pathname.startsWith("/admin/export/")) {
    const user = requireUser(req, res, ["admin"]); if (!user) return true;
    if (pathname.endsWith("/all.xlsx")) {
      sendXlsx(res, `${EXPORT_PREFIX}-all-report.xlsx`, [
        { name: "平台資訊", rows: [{ 平台名稱: PLATFORM_NAME, 版本: PLATFORM_VERSION }] },
        { name: "分店總覽", rows: storeReportRows() },
        { name: "會員總覽", rows: memberReportRows() },
        { name: "點數交易紀錄", rows: transactionReportRows() },
        { name: "扣點申請紀錄", rows: requestReportRows() },
        { name: "月報統計", rows: monthlyReportRows() },
        { name: "管理員帳號", rows: adminUserRows() },
        { name: "管理員申請紀錄", rows: adminRequestRows() },
        { name: "總部登入登出紀錄", rows: isSuperAdmin(user) ? adminAuditRows() : [] }
      ]);
      return true;
    }
    if (pathname.endsWith("/stores.csv")) sendCsv(res, `${EXPORT_PREFIX}-stores.csv`, storeReportRows());
    else if (pathname.endsWith("/members.csv")) sendCsv(res, `${EXPORT_PREFIX}-members.csv`, memberReportRows());
    else if (pathname.endsWith("/transactions.csv")) sendCsv(res, `${EXPORT_PREFIX}-transactions.csv`, transactionReportRows());
    else if (pathname.endsWith("/requests.csv")) sendCsv(res, `${EXPORT_PREFIX}-requests.csv`, requestReportRows());
    else return false;
    return true;
  }
  if (pathname.startsWith("/store/export/")) {
    const user = requireUser(req, res, ["store"]); if (!user) return true;
    if (pathname.endsWith("/all.xlsx")) {
      sendXlsx(res, `${EXPORT_PREFIX}-store-report.xlsx`, [
        { name: "平台資訊", rows: [{ 平台名稱: PLATFORM_NAME, 版本: PLATFORM_VERSION }] },
        { name: "會員資料", rows: memberReportRows(user.store_id) },
        { name: "交易紀錄", rows: transactionReportRows(user.store_id) },
        { name: "扣點紀錄", rows: requestReportRows(user.store_id) },
        { name: "月報統計", rows: monthlyReportRows(user.store_id) }
      ]);
      return true;
    }
    if (pathname.endsWith("/members.csv")) sendCsv(res, `${EXPORT_PREFIX}-store-members.csv`, memberReportRows(user.store_id));
    else if (pathname.endsWith("/transactions.csv")) sendCsv(res, `${EXPORT_PREFIX}-store-transactions.csv`, transactionReportRows(user.store_id));
    else if (pathname.endsWith("/requests.csv")) sendCsv(res, `${EXPORT_PREFIX}-store-requests.csv`, requestReportRows(user.store_id));
    else return false;
    return true;
  }
  return false;
}

async function handleMediaUpload(req, res) {
  const user = requireUser(req, res, ["admin"]);
  if (!user) return;
  let form;
  try {
    form = await parseMultipartForm(req);
    if (!isCloudinaryConfigured()) throw new Error("媒體上傳尚未設定。");
    const file = form.files.image;
    const mimeType = validateImageUpload(file);
    const result = await uploadToCloudinary(file, mimeType);
    const displayName = String(form.fields.display_name || "").trim().slice(0, 120);
    const altText = String(form.fields.alt_text || "").trim().slice(0, 180);
    let asset;
    try {
      asset = db.prepare(`
        INSERT INTO media_assets (
          provider, public_id, secure_url, original_filename, display_name, alt_text,
          mime_type, file_size, width, height, folder, uploaded_by_user_id, is_active
        )
        VALUES ('cloudinary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        RETURNING id, secure_url
      `).get(
        result.public_id,
        result.secure_url,
        file.filename || "",
        displayName,
        altText,
        mimeType,
        file.data.length,
        result.width || null,
        result.height || null,
        CLOUDINARY_FOLDER,
        user.id
      );
    } catch (dbError) {
      console.error("Cloudinary upload succeeded but media_assets insert failed.", { public_id: result.public_id, message: dbError.message });
      throw new Error("圖片已上傳，但媒體資料保存失敗。請聯絡管理員處理。");
    }
    const context = String(form.fields.context || "");
    const productId = Number(form.fields.product_id || 0);
    if (context === "mall" && productId) {
      const product = db.prepare("SELECT id, product_code FROM products WHERE id = ?").get(productId);
      if (product) {
        db.prepare("UPDATE products SET media_asset_id = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(asset.id, asset.secure_url, product.id);
        return redirect(res, `/admin/mall?edit=${encodeURIComponent(product.product_code)}&message=${encodeURIComponent("圖片已上傳並套用到商品。")}`);
      }
    }
    if (context === "mall") {
      return redirect(res, `/admin/mall?media=${asset.id}&message=${encodeURIComponent("圖片已上傳，已帶回商品表單。")}`);
    }
    return redirect(res, `/admin/media?message=${encodeURIComponent("圖片上傳成功。")}`);
  } catch (error) {
    const safeMessage = String(error?.message || "圖片上傳失敗。").replace(/api[_-]?secret|CLOUDINARY_API_SECRET/ig, "secret");
    const fallback = form?.fields?.context === "mall" ? "/admin/mall" : "/admin/media";
    return redirect(res, `${fallback}?message=${encodeURIComponent(safeMessage)}`);
  }
}

async function handlePost(req, res, pathname) {
  if (!isSameOriginPost(req)) return send(res, 403, page("請求遭拒", `<div class="empty">基於安全性，此跨網站請求已被拒絕。</div>`));
  if (pathname === "/admin/media/upload") return handleMediaUpload(req, res);
  const body = await readBody(req);
  if (pathname === "/member/register") {
    if (!memberFoundation.featureEnabled(db, "member_self_registration")) {
      return send(res, 404, page("功能尚未開放", `<div class="empty">會員自行註冊目前尚未開放。</div>`));
    }
    if (!validMemberName(body.name)) return send(res, 400, memberRegistrationPage("姓名需為 2 至 80 個字元。", body));
    if (!validMemberEmail(body.email)) return send(res, 400, memberRegistrationPage("請輸入有效的 Email。", body));
    if (!validMemberPhone(body.phone)) return send(res, 400, memberRegistrationPage("請輸入有效的台灣手機號碼，例如 0912345678。", body));
    const requestIp = clientIp(req);
    if (memberFoundation.activationEmailAttemptCount(db, {
      eventTypes: ACTIVATION_EMAIL_EVENTS,
      ip: requestIp,
      sinceMinutes: 60
    }) >= 10) {
      return send(res, 429, memberRegistrationPage("請求過於頻繁，請稍後再試。", {}), { "Retry-After": "3600" });
    }
    let memberCode = generateMemberCode();
    while (db.prepare("SELECT id FROM members WHERE member_code = ?").get(memberCode)) memberCode = generateMemberCode();
    try {
      const registered = memberFoundation.registerPendingMember(db, {
        name: body.name,
        email: body.email,
        phone: body.phone,
        memberCode,
        temporaryPasswordHash: hashPassword(generateTemporaryPassword()),
        referralCode: String(body.referral_code || "").trim() || null,
        activationTtlMinutes: ACTIVATION_TOKEN_TTL_MINUTES
      });
      memberFoundation.recordActivationEmailAudit(db, {
        eventType: "activation_email_requested",
        memberId: registered.memberId,
        email: body.email,
        ip: requestIp,
        result: "requested"
      });
      try {
        const sent = await activationEmail.sendActivationEmail({
          to: body.email,
          name: body.name,
          token: registered.activationToken
        });
        memberFoundation.recordActivationEmailAudit(db, {
          eventType: "activation_email_sent",
          memberId: registered.memberId,
          email: body.email,
          ip: requestIp,
          result: "sent",
          reason: sent.id
        });
      } catch (emailError) {
        memberFoundation.recordActivationEmailAudit(db, {
          eventType: "activation_email_failed",
          memberId: registered.memberId,
          email: body.email,
          ip: requestIp,
          result: "failed",
          reason: emailError.message
        });
      }
      return send(res, 201, memberRegistrationPage("", {}, true), { "Cache-Control": "no-store" });
    } catch (error) {
      const messages = {
        "Referrer is invalid.": "推薦碼不存在或推薦人尚未啟用，請確認後再試。"
      };
      if (error.message === "Email is already registered." || error.message === "Phone is already registered.") {
        return send(res, 202, memberRegistrationPage("", {}, true), { "Cache-Control": "no-store" });
      }
      if (messages[error.message]) return send(res, 400, memberRegistrationPage(messages[error.message], body));
      throw error;
    }
  }
  if (pathname === "/member/activation/resend") {
    if (!memberFoundation.featureEnabled(db, "member_self_registration")) {
      return send(res, 404, page("功能尚未開放", `<div class="empty">會員自行註冊目前尚未開放。</div>`));
    }
    const email = memberFoundation.normalizeEmail(body.email);
    const requestIp = clientIp(req);
    const genericResponse = () => send(res, 202, memberRegistrationPage("", {}, true), { "Cache-Control": "no-store" });
    if (!validMemberEmail(email)) return genericResponse();
    const emailAttempts = memberFoundation.activationEmailAttemptCount(db, {
      eventTypes: ACTIVATION_EMAIL_EVENTS,
      email,
      sinceMinutes: 60
    });
    const ipAttempts = memberFoundation.activationEmailAttemptCount(db, {
      eventTypes: ACTIVATION_EMAIL_EVENTS,
      ip: requestIp,
      sinceMinutes: 60
    });
    if (emailAttempts >= 3 || ipAttempts >= 10) {
      memberFoundation.recordActivationEmailAudit(db, {
        eventType: "activation_email_rate_limited",
        email,
        ip: requestIp,
        result: "blocked"
      });
      return genericResponse();
    }
    const pending = memberFoundation.pendingMemberByEmail(db, email);
    if (!pending) return genericResponse();
    const token = memberFoundation.createActivationToken(db, pending.memberId, ACTIVATION_TOKEN_TTL_MINUTES);
    memberFoundation.recordActivationEmailAudit(db, {
      eventType: "activation_email_requested",
      memberId: pending.memberId,
      email,
      ip: requestIp,
      result: "requested"
    });
    try {
      const sent = await activationEmail.sendActivationEmail({ to: email, name: pending.name, token });
      memberFoundation.recordActivationEmailAudit(db, {
        eventType: "activation_email_sent",
        memberId: pending.memberId,
        email,
        ip: requestIp,
        result: "sent",
        reason: sent.id
      });
    } catch (emailError) {
      memberFoundation.recordActivationEmailAudit(db, {
        eventType: "activation_email_failed",
        memberId: pending.memberId,
        email,
        ip: requestIp,
        result: "failed",
        reason: emailError.message
      });
    }
    return genericResponse();
  }
  if (pathname === "/member/activate") {
    const token = String(body.token || "");
    if (!validInitialPassword(body.password)) {
      return send(res, 400, memberActivationPage(token, "密碼需為 12 至 128 個字元。"));
    }
    if (body.password !== body.confirm_password) {
      return send(res, 400, memberActivationPage(token, "密碼與確認密碼不一致。"));
    }
    try {
      memberFoundation.activateMemberWithPassword(db, token, hashPassword(body.password));
      return send(res, 200, memberActivationPage("", "", true), { "Cache-Control": "no-store" });
    } catch (error) {
      if (/invalid or expired|not pending/i.test(error.message)) {
        return send(res, 400, memberActivationPage("", "此啟用連結無效、已使用或已過期，請重新申請。"));
      }
      throw error;
    }
  }
  if (pathname === "/login") {
    const loginEmail = normalizeEmail(body.email);
    const user = db.prepare("SELECT * FROM users WHERE lower(email) = ? AND role = ?").get(loginEmail, body.role);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      if (body.role === "admin") {
        const admin = db.prepare("SELECT * FROM users WHERE lower(email) = ? AND role = 'admin'").get(loginEmail);
        recordAdminAudit(req, {
          eventType: "login",
          email: loginEmail,
          user: admin || null,
          result: "failed",
          failureReason: admin ? "密碼錯誤" : "帳號不存在"
        });
      }
      return send(res, 401, loginPage(body.role || "member", "帳號或密碼不正確。", body.slug || ""));
    }
    if (user.status === "disabled") {
      if (body.role === "admin") {
        recordAdminAudit(req, { eventType: "login", email: body.email, user, result: "failed", failureReason: "帳號停用" });
      }
      return send(res, 403, loginPage(body.role || "member", "此帳號已停用，請聯絡管理員。", body.slug || ""));
    }
    if (user.role === "member") {
      const profile = db.prepare(`SELECT member_profiles.activation_status
        FROM members JOIN member_profiles ON member_profiles.member_id = members.id
        WHERE members.user_id = ?`).get(user.id);
      if (profile?.activation_status === "pending") {
        return send(res, 403, loginPage("member", "帳號尚未啟用，請使用啟用連結設定密碼。"));
      }
      if (profile?.activation_status === "disabled") {
        return send(res, 403, loginPage("member", "此會員帳號已停用，請聯絡平台。"));
      }
    }
    if (body.role === "store" && body.slug) {
      const store = db.prepare("SELECT * FROM stores WHERE platform_slug = ?").get(body.slug);
      if (!store || store.id !== user.store_id) return send(res, 403, loginPage("store", "此帳號不屬於這個分店連結。", body.slug));
    }
    const target = user.role === "admin" ? "/admin/dashboard" : user.role === "store" ? "/store/dashboard" : "/member/dashboard";
    if (user.role === "admin") {
      recordAdminAudit(req, { eventType: "login", email: user.email, user, result: "success" });
    }
    res.writeHead(302, { ...securityHeaders(), "Cache-Control": "no-store", "Set-Cookie": `session=${encodeURIComponent(makeToken(user))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800; ${COOKIE_SECURE ? "Secure; " : ""}`, Location: target });
    return res.end();
  }
  if (pathname === "/logout") {
    const user = currentUser(req);
    if (user?.role === "admin") {
      recordAdminAudit(req, { eventType: "logout", email: user.email, user, result: "success" });
    }
    res.writeHead(302, { ...securityHeaders(), "Set-Cookie": `session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/; ${COOKIE_SECURE ? "Secure; " : ""}`, Location: "/" });
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
      ...securityHeaders(),
      "Set-Cookie": `session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/; ${COOKIE_SECURE ? "Secure; " : ""}`,
      Location: `${loginPathForRole(user.role)}?passwordChanged=1`
    });
    return res.end();
  }
  if (pathname === "/admin/mall/types") {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    const name = String(body.name || "").trim();
    const sortOrder = Number(body.sort_order || 0);
    if (!name) return adminMallPage(req, res, user, "請輸入商品類型名稱。");
    if (!Number.isInteger(sortOrder)) return adminMallPage(req, res, user, "商品類型排序必須是整數。");
    try {
      db.prepare("INSERT INTO product_types (name, sort_order, is_active) VALUES (?, ?, 1)").run(name, sortOrder);
      return redirect(res, "/admin/mall");
    } catch (error) {
      if (isUniqueConstraintError(error)) return adminMallPage(req, res, user, "此商品類型已存在。");
      throw error;
    }
  }
  if (pathname === "/admin/mall/categories") {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    const typeId = Number(body.type_id);
    const name = String(body.name || "").trim();
    const sortOrder = Number(body.sort_order || 0);
    if (!db.prepare("SELECT id FROM product_types WHERE id = ?").get(typeId)) return adminMallPage(req, res, user, "請選擇有效的商品類型。");
    if (!name) return adminMallPage(req, res, user, "請輸入商品分類名稱。");
    if (!Number.isInteger(sortOrder)) return adminMallPage(req, res, user, "商品分類排序必須是整數。");
    try {
      db.prepare("INSERT INTO product_categories (type_id, name, sort_order, is_active) VALUES (?, ?, ?, 1)").run(typeId, name, sortOrder);
      return redirect(res, "/admin/mall");
    } catch (error) {
      if (isUniqueConstraintError(error)) return adminMallPage(req, res, user, "此商品分類已存在。");
      throw error;
    }
  }
  if (pathname === "/admin/mall/products") {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    const id = body.id ? Number(body.id) : null;
    const productCode = String(body.product_code || "").trim().toUpperCase();
    const name = String(body.name || "").trim();
    const typeId = Number(body.type_id);
    const categoryId = body.category_id ? Number(body.category_id) : null;
    const shortDescription = String(body.short_description || "").trim();
    const selectedMedia = mediaAssetById(body.media_asset_id);
    const mediaAssetId = selectedMedia ? selectedMedia.id : null;
    const imageUrl = selectedMedia ? selectedMedia.secure_url : validHttpUrl(body.image_url, false);
    const productPageUrl = validHttpUrl(body.product_page_url, true);
    const price = parseOptionalPrice(body.price);
    const sortOrder = Number(body.sort_order || 0);
    const isActive = body.is_active === "1" ? 1 : 0;
    const values = { ...body, id, product_code: productCode, type_id: typeId, category_id: categoryId, media_asset_id: mediaAssetId, image_url: imageUrl || body.image_url || "", price, sort_order: sortOrder, is_active: isActive };
    if (!/^[A-Z0-9_-]{2,40}$/.test(productCode)) return adminMallPage(req, res, user, "商品編號只能使用英文、數字、底線或連字號。", values);
    if (!name) return adminMallPage(req, res, user, "請輸入商品名稱。", values);
    if (!db.prepare("SELECT id FROM product_types WHERE id = ?").get(typeId)) return adminMallPage(req, res, user, "請選擇有效的商品類型。", values);
    if (categoryId && !db.prepare("SELECT id FROM product_categories WHERE id = ? AND type_id = ?").get(categoryId, typeId)) return adminMallPage(req, res, user, "商品分類必須屬於所選商品類型。", values);
    if (imageUrl === null) return adminMallPage(req, res, user, "商品圖片網址必須是 http 或 https。", values);
    if (!productPageUrl) return adminMallPage(req, res, user, "商品介紹網址必須是 http 或 https。", values);
    if (Number.isNaN(price)) return adminMallPage(req, res, user, "價格必須是 0 或正整數，或留空顯示價格洽詢。", values);
    if (!Number.isInteger(sortOrder)) return adminMallPage(req, res, user, "顯示順序必須是整數。", values);
    try {
      if (id) {
        const existing = db.prepare("SELECT id FROM products WHERE id = ?").get(id);
        if (!existing) return adminMallPage(req, res, user, "找不到要修改的商品。", values);
        db.prepare(`
          UPDATE products
          SET product_code = ?, name = ?, type_id = ?, category_id = ?, short_description = ?, media_asset_id = ?, image_url = ?,
              product_page_url = ?, price = ?, currency = 'TWD', payment_provider = 'ecpay',
              is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(productCode, name, typeId, categoryId, shortDescription, mediaAssetId, imageUrl || "", productPageUrl, price, isActive, sortOrder, id);
      } else {
        db.prepare(`
          INSERT INTO products (product_code, name, type_id, category_id, short_description, media_asset_id, image_url, product_page_url, price, currency, payment_provider, is_active, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'TWD', 'ecpay', ?, ?)
        `).run(productCode, name, typeId, categoryId, shortDescription, mediaAssetId, imageUrl || "", productPageUrl, price, isActive, sortOrder);
      }
      return redirect(res, "/admin/mall");
    } catch (error) {
      if (isUniqueConstraintError(error)) return adminMallPage(req, res, user, "此商品編號已存在。", values);
      throw error;
    }
  }
  const productToggleMatch = pathname.match(/^\/admin\/mall\/products\/(\d+)\/toggle$/);
  if (productToggleMatch) {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    const product = db.prepare("SELECT id, is_active FROM products WHERE id = ?").get(productToggleMatch[1]);
    if (product) {
      db.prepare("UPDATE products SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(product.is_active ? 0 : 1, product.id);
    }
    return redirect(res, "/admin/mall");
  }
  if (pathname === "/admin/stores") {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    if (!validInitialPassword(body.password)) return send(res, 400, page("新增分店", storeForm("初始密碼需為 12 至 128 個字元。", body), user));
    if (emailExistsForRole(body.email, "store")) {
      return send(res, 400, page("新增分店", storeForm("此 Email 已在相同角色中使用，請更換 Email。", body), user));
    }
    try {
      const slug = slugify(body.store_name);
      db.exec("BEGIN");
      const store = db.prepare(`
        INSERT INTO stores (store_name, contact_name, phone, email, platform_slug)
        VALUES (?, ?, ?, ?, ?) RETURNING id
      `).get(body.store_name, body.contact_name, body.phone, normalizeEmail(body.email), slug);
      db.prepare(`
        INSERT INTO users (role, name, phone, email, password_hash, store_id)
        VALUES ('store', ?, ?, ?, ?, ?)
      `).run(body.store_name, body.phone, normalizeEmail(body.email), hashPassword(body.password), store.id);
      db.exec("COMMIT");
      return redirect(res, `/admin/stores/${store.id}`);
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintError(error)) {
        return send(res, 400, page("新增分店", storeForm(uniqueConstraintMessage(error), body), user));
      }
      throw error;
    }
  }
  if (pathname === "/store/members") {
    const user = requireUser(req, res, ["store"]); if (!user) return;
    if (!validInitialPassword(body.password)) return send(res, 400, page("新增會員", memberForm("初始密碼需為 12 至 128 個字元。", body), user));
    if (emailExistsForRole(body.email, "member")) {
      return send(res, 400, page("新增會員", memberForm("此 Email 已在相同角色中使用，請更換 Email。", body), user));
    }
    try {
      db.exec("BEGIN");
      const newUser = db.prepare(`
        INSERT INTO users (role, name, phone, email, password_hash, store_id)
        VALUES ('member', ?, ?, ?, ?, ?) RETURNING id
      `).get(body.name, body.phone, normalizeEmail(body.email), hashPassword(body.password), user.store_id);
      const member = db.prepare(`
        INSERT INTO members (store_id, user_id, member_code, name, phone, email)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id
      `).get(user.store_id, newUser.id, generateMemberCode(), body.name, body.phone, normalizeEmail(body.email));
      db.exec("COMMIT");
      return redirect(res, `/store/members/${member.id}`);
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintError(error)) {
        return send(res, 400, page("新增會員", memberForm(uniqueConstraintMessage(error), body), user));
      }
      throw error;
    }
  }
  if (pathname === "/store/cross-store/deductions") {
    const user = requireUser(req, res, ["store"]); if (!user) return;
    const member = db.prepare("SELECT id FROM members WHERE id = ?").get(body.member_id);
    if (!member) return crossStorePage(req, res, user, "", "找不到會員。");
    db.prepare(`
      INSERT INTO deduction_requests (store_id, member_id, points, description, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(user.store_id, member.id, Number(body.points), body.description || "");
    return redirect(res, "/store/deductions");
  }
  if (pathname === "/admin/manager-requests" || pathname === "/store/manager-requests") {
    const user = requireUser(req, res, ["admin", "store"]); if (!user) return;
    const role = user.role === "store" ? "store" : body.role;
    const storeId = role === "store" ? Number(body.store_id || user.store_id) : null;
    if (role === "store" && !storeId) return managerRequestsPage(res, user, "分店管理員必須選擇所屬分店。");
    if (emailExistsForRole(body.email, role)) return managerRequestsPage(res, user, "此 Email 已在相同角色中使用，請更換 Email。");
    const pendingRequest = db.prepare("SELECT id FROM admin_account_requests WHERE lower(email) = lower(?) AND role = ? AND status = 'pending' LIMIT 1").get(body.email, role);
    if (pendingRequest) return managerRequestsPage(res, user, "此 Email 已有相同角色的待審核申請。");
    try {
      db.prepare(`
        INSERT INTO admin_account_requests (name, email, phone, role, store_id, status, requested_by)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(body.name, normalizeEmail(body.email), body.phone || "", role, storeId, user.id);
      return redirect(res, user.role === "admin" ? "/admin/manager-requests" : "/store/manager-requests");
    } catch (error) {
      if (isUniqueConstraintError(error)) return managerRequestsPage(res, user, uniqueConstraintMessage(error));
      throw error;
    }
  }
  const reviewMatch = pathname.match(/^\/admin\/manager-requests\/(\d+)\/review$/);
  if (reviewMatch) {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    if (!isSuperAdmin(user)) return send(res, 403, page("無權限", `<div class="empty">只有總部專職管理員可以核准或拒絕。</div>`, user));
    const request = db.prepare("SELECT * FROM admin_account_requests WHERE id = ? AND status = 'pending'").get(reviewMatch[1]);
    if (!request) return redirect(res, "/admin/manager-requests");
    if (body.decision === "rejected") {
      db.prepare("UPDATE admin_account_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id, request.id);
      return redirect(res, "/admin/manager-requests");
    }
    if (emailExistsForRole(request.email, request.role)) return managerRequestsPage(res, user, "此 Email 已在相同角色中使用，無法核准此申請。");
    try {
      db.exec("BEGIN");
      const temporaryPassword = generateTemporaryPassword();
      const newUser = db.prepare(`
        INSERT INTO users (role, name, phone, email, password_hash, store_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active') RETURNING id
      `).get(request.role, request.name, request.phone || "", request.email, hashPassword(temporaryPassword), request.role === "store" ? request.store_id : null);
      db.prepare("UPDATE admin_account_requests SET status = 'approved', user_id = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(newUser.id, user.id, request.id);
      db.exec("COMMIT");
      return managerRequestsPage(res, user, `帳號已核准。臨時密碼（僅顯示一次）：${temporaryPassword}`);
    } catch (error) {
      db.exec("ROLLBACK");
      if (isUniqueConstraintError(error)) return managerRequestsPage(res, user, uniqueConstraintMessage(error));
      throw error;
    }
  }
  const statusMatch = pathname.match(/^\/admin\/users\/(\d+)\/status$/);
  if (statusMatch) {
    const user = requireUser(req, res, ["admin"]); if (!user) return;
    if (!isSuperAdmin(user)) return send(res, 403, page("無權限", `<div class="empty">只有總部專職管理員可以停用或恢復管理員。</div>`, user));
    const target = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('admin','store')").get(statusMatch[1]);
    if (target && target.is_super_admin !== 1) {
      const status = body.status === "active" ? "active" : "disabled";
      db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, target.id);
      db.prepare(`
        INSERT INTO admin_account_requests (name, email, phone, role, store_id, status, user_id, requested_by, reviewed_by, reviewed_at, disabled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CASE WHEN ? = 'disabled' THEN CURRENT_TIMESTAMP ELSE NULL END)
      `).run(target.name, target.email, target.phone || "", target.role, target.store_id, status, target.id, user.id, user.id, status);
    }
    return redirect(res, "/admin/manager-requests");
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

function imageContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[ext] || "";
}

function servePublicImage(res, pathname) {
  let rel = "";
  try {
    rel = decodeURIComponent(pathname.replace(/^\/images\//, ""));
  } catch {
    return false;
  }
  if (!rel || rel.includes("\0")) return false;
  const file = path.resolve(PUBLIC_IMAGES_DIR, rel);
  if (!file.startsWith(`${PUBLIC_IMAGES_DIR}${path.sep}`)) return false;
  const type = imageContentType(file);
  if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
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
    if (pathname.startsWith("/images/")) {
      if (servePublicImage(res, pathname)) return;
      return sendText(res, 404, "Not found");
    }
    if (req.method === "GET" && handleExport(req, res, pathname)) return;
    if (req.method === "POST") return await handlePost(req, res, pathname);

    if (pathname === "/") return redirect(res, "/admin/login");
    const passwordChangedMessage = url.searchParams.get("passwordChanged") ? "密碼已更新，請使用新密碼重新登入。" : "";
    if (pathname === "/admin/login") return send(res, 200, loginPage("admin", passwordChangedMessage));
    if (pathname === "/store/login") return send(res, 200, loginPage("store", passwordChangedMessage));
    if (pathname === "/member/login") return send(res, 200, loginPage("member", passwordChangedMessage));
    if (pathname === "/member/register") {
      if (!memberFoundation.featureEnabled(db, "member_self_registration")) {
        return send(res, 404, page("功能尚未開放", `<div class="empty">會員自行註冊目前尚未開放。</div>`));
      }
      return send(res, 200, memberRegistrationPage());
    }
    if (pathname === "/member/activate") {
      const token = url.searchParams.get("token") || "";
      if (!token) return send(res, 400, memberActivationPage("", "啟用連結不完整。"));
      return send(res, 200, memberActivationPage(token), { "Cache-Control": "no-store" });
    }
    const slugLogin = pathname.match(/^\/store\/([^/]+)\/login$/);
    if (slugLogin) return send(res, 200, loginPage("store", "", slugLogin[1]));

    if (pathname === "/account/password") {
      const user = requireUser(req, res, ["admin", "store", "member"]);
      if (user) return send(res, 200, passwordPage(user));
      return;
    }

    if (pathname === "/admin/dashboard") { const user = requireUser(req, res, ["admin"]); if (user) return adminDashboard(req, res, user); return; }
    if (pathname === "/admin/mall") { const user = requireUser(req, res, ["admin"]); if (user) return adminMallPage(req, res, user); return; }
    if (pathname === "/admin/media") { const user = requireUser(req, res, ["admin"]); if (user) return adminMediaPage(req, res, user); return; }
    if (pathname === "/admin/reports") { const user = requireUser(req, res, ["admin"]); if (user) return adminReports(req, res, user); return; }
    if (pathname === "/admin/manager-requests") { const user = requireUser(req, res, ["admin"]); if (user) return managerRequestsPage(res, user); return; }
    if (pathname === "/admin/audit-logs") { const user = requireUser(req, res, ["admin"]); if (user) return adminAuditPage(res, user); return; }
    if (pathname === "/admin/stores") { const user = requireUser(req, res, ["admin"]); if (user) return adminStores(req, res, user); return; }
    if (pathname === "/admin/stores/new") { const user = requireUser(req, res, ["admin"]); if (user) return send(res, 200, page("新增分店", storeForm(), user)); return; }
    if (pathname === "/admin/members") { const user = requireUser(req, res, ["admin"]); if (user) return adminMembers(req, res, user); return; }
    const adminStore = pathname.match(/^\/admin\/stores\/(\d+)$/);
    if (adminStore) { const user = requireUser(req, res, ["admin"]); if (user) return adminStoreDetail(req, res, user, adminStore[1]); return; }
    const adminView = pathname.match(/^\/admin\/stores\/(\d+)\/view$/);
    if (adminView) { const user = requireUser(req, res, ["admin"]); if (user) return renderStoreDashboard(res, user, adminView[1], true); return; }

    if (pathname === "/store/dashboard") { const user = requireUser(req, res, ["store"]); if (user) return renderStoreDashboard(res, user, user.store_id); return; }
    if (pathname === "/store/mall") { const user = requireUser(req, res, ["store"]); if (user) return mallPage(res, user); return; }
    if (pathname === "/store/reports") { const user = requireUser(req, res, ["store"]); if (user) return storeReports(req, res, user); return; }
    if (pathname === "/store/cross-store") { const user = requireUser(req, res, ["store"]); if (user) return crossStorePage(req, res, user, url.searchParams.get("q") || ""); return; }
    if (pathname === "/store/manager-requests") { const user = requireUser(req, res, ["store"]); if (user) return managerRequestsPage(res, user); return; }
    if (pathname === "/store/members") { const user = requireUser(req, res, ["store"]); if (user) return storeMembers(req, res, user); return; }
    if (pathname === "/store/members/new") { const user = requireUser(req, res, ["store"]); if (user) return send(res, 200, page("新增會員", memberForm(), user)); return; }
    const memberDetail = pathname.match(/^\/store\/members\/(\d+)$/);
    if (memberDetail) { const user = requireUser(req, res, ["store"]); if (user) return storeMemberDetail(req, res, user, memberDetail[1]); return; }
    if (pathname === "/store/deductions") { const user = requireUser(req, res, ["store"]); if (user) return storeDeductions(req, res, user); return; }

    if (pathname === "/member/dashboard") { const user = requireUser(req, res, ["member"]); if (user) return memberDashboard(req, res, user); return; }
    if (pathname === "/member/mall") { const user = requireUser(req, res, ["member"]); if (user) return mallPage(res, user); return; }
    if (pathname === "/member/share-center") { const user = requireUser(req, res, ["member"]); if (user) return memberShareCenter(req, res, user); return; }

    send(res, 404, page("找不到頁面", `<div class="empty">找不到這個頁面。</div>`, currentUser(req)));
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error(error);
    if (isUniqueConstraintError(error)) {
      return send(res, 400, page("資料重複", `<div class="notice">${uniqueConstraintMessage(error)}</div>`, currentUser(req)));
    }
    send(res, status, page("系統錯誤", `<div class="empty">${status === 413 ? "請求內容過大。" : "系統暫時無法處理請求，請稍後再試。"}</div>`, currentUser(req)));
  }
}

if (!db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) {
  console.log("No seed data found. Run: node scripts/seed.js");
}

http.createServer(router).listen(PORT, HOST, () => {
  console.log(`${PLATFORM_NAME} ${PLATFORM_VERSION} running at http://${HOST}:${PORT}`);
});
