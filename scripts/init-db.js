const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..");
loadEnv(path.join(root, ".env"));

const dbPath = path.resolve(root, process.env.DATABASE_PATH || "data/app.sqlite");
const schemaPath = path.join(root, "schema.sql");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(schemaPath, "utf8"));

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

const superAdminEmail = "luodayu168@gmail.com";
const superAdminPassword = "QazxsW12345";
const existingSuperAdmin = db.prepare("SELECT id, email FROM users WHERE role = 'admin' AND email = ? LIMIT 1").get(superAdminEmail);

if (existingSuperAdmin) {
  try {
    db.prepare("UPDATE users SET status = 'active', is_super_admin = 1 WHERE id = ?").run(existingSuperAdmin.id);
  } catch {
    // Older databases are migrated by server.js on startup.
  }
  console.log(`Database ready. Existing super admin: ${existingSuperAdmin.email}`);
  process.exit(0);
}

const adminEmail = process.env.INITIAL_ADMIN_EMAIL || superAdminEmail;
const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || superAdminPassword;
const adminName = process.env.INITIAL_ADMIN_NAME || "總部專職管理員";

db.prepare(`
  INSERT INTO users (role, name, phone, email, password_hash, status, is_super_admin)
  VALUES ('admin', ?, ?, ?, ?, 'active', ?)
`).run(adminName, process.env.INITIAL_ADMIN_PHONE || "", adminEmail, hashPassword(adminPassword), adminEmail === superAdminEmail ? 1 : 0);

console.log("Database ready. Initial admin created.");
console.log(`Admin email: ${adminEmail}`);
