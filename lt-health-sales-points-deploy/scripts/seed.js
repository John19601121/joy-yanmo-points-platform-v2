const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..");
loadEnv(path.join(root, ".env"));

const dbPath = path.resolve(root, process.env.DATABASE_PATH || "data/app.sqlite");
const schemaPath = path.join(root, "schema.sql");

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

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(fs.readFileSync(schemaPath, "utf8"));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64url");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

const passwordHash = hashPassword("password123");

db.prepare(`
  INSERT INTO users (role, name, phone, email, password_hash)
  VALUES ('admin', '總部管理員', '0900000000', 'admin@joy-yanmo.test', ?)
`).run(passwordHash);

const store = db.prepare(`
  INSERT INTO stores (store_name, contact_name, phone, email, platform_slug)
  VALUES ('台北信義旗艦店', '王店長', '02-2345-6789', 'taipei@joy-yanmo.test', 'taipei-xinyi')
  RETURNING id
`).get();

db.prepare(`
  INSERT INTO users (role, name, phone, email, password_hash, store_id)
  VALUES ('store', '台北信義旗艦店', '02-2345-6789', 'taipei@joy-yanmo.test', ?, ?)
`).run(passwordHash, store.id);

const memberUser = db.prepare(`
  INSERT INTO users (role, name, phone, email, password_hash, store_id)
  VALUES ('member', '林雅婷', '0912345678', 'member.lin@example.com', ?, ?)
  RETURNING id
`).get(passwordHash, store.id);

const member = db.prepare(`
  INSERT INTO members (store_id, user_id, name, phone, email)
  VALUES (?, ?, '林雅婷', '0912345678', 'member.lin@example.com')
  RETURNING id
`).get(store.id, memberUser.id);

db.prepare(`
  INSERT INTO point_transactions (store_id, member_id, type, points, description, status)
  VALUES (?, ?, 'purchase', 1200, '開卡購買點數', 'completed')
`).run(store.id, member.id);

db.prepare(`
  INSERT INTO point_transactions (store_id, member_id, type, points, description, status)
  VALUES (?, ?, 'gift', 200, '新會員迎賓贈點', 'completed')
`).run(store.id, member.id);

db.prepare(`
  INSERT INTO deduction_requests (store_id, member_id, points, description, status)
  VALUES (?, ?, 300, '臉部保養課程扣點', 'pending')
`).run(store.id, member.id);

console.log("Seed completed.");
console.log("Admin: admin@joy-yanmo.test / password123");
console.log("Store: taipei@joy-yanmo.test / password123");
console.log("Member: member.lin@example.com / password123");
