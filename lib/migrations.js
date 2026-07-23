const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function applyMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const files = fs.readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const applied = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(file);
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`Applied migration was modified: ${file}`);
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)").run(file, checksum);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

module.exports = { applyMigrations };
