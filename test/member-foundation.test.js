const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");
const foundation = require("../lib/member-foundation");

const root = path.join(__dirname, "..");

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-member-test-"));
  const db = new DatabaseSync(path.join(directory, "test.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  applyMigrations(db, path.join(root, "migrations"));
  return { db, directory };
}

function addMember(db, suffix, storeId = foundation.headquartersId(db)) {
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', ?, ?, ?, 'test-hash', ?) RETURNING id`)
    .get(`會員${suffix}`, `09120000${suffix}`, `member${suffix}@example.com`, storeId);
  return db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(storeId, user.id, `LTTEST${suffix}`, `會員${suffix}`, `09120000${suffix}`, `member${suffix}@example.com`).id;
}

test("migrations are idempotent and create one disabled-by-default headquarters foundation", () => {
  const { db, directory } = database();
  applyMigrations(db, path.join(root, "migrations"));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 5);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM stores WHERE is_system_default = 1").get().count, 1);
  assert.deepEqual(db.prepare("SELECT enabled FROM feature_flags ORDER BY name").all().map((row) => row.enabled), [0, 0]);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("an applied migration cannot be silently modified", () => {
  const { db, directory } = database();
  const changedDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-changed-migration-"));
  fs.writeFileSync(path.join(changedDir, "001_headquarters.sql"), "SELECT 1;");
  assert.throws(() => applyMigrations(db, changedDir), /modified/);
  db.close(); fs.rmSync(directory, { recursive: true }); fs.rmSync(changedDir, { recursive: true });
});

test("failed migration rolls back without a version record", () => {
  const { db, directory } = database();
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-bad-migration-"));
  fs.writeFileSync(path.join(badDir, "999_bad.sql"), "CREATE TABLE must_rollback (id INTEGER); INVALID SQL;");
  assert.throws(() => applyMigrations(db, badDir));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'").get(), undefined);
  assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version = '999_bad.sql'").get(), undefined);
  db.close(); fs.rmSync(directory, { recursive: true }); fs.rmSync(badDir, { recursive: true });
});

test("normalization and global member identity uniqueness work", () => {
  const { db, directory } = database();
  const first = addMember(db, "01");
  const second = addMember(db, "02");
  assert.equal(foundation.normalizeEmail(" TEST@Example.COM "), "test@example.com");
  assert.equal(foundation.normalizePhone("+886 912-345-678"), "0912345678");
  db.prepare("INSERT INTO member_profiles (member_id, normalized_email, normalized_phone) VALUES (?, ?, ?)")
    .run(first, "test@example.com", "0912345678");
  assert.throws(() => db.prepare("INSERT INTO member_profiles (member_id, normalized_email) VALUES (?, ?)").run(second, "test@example.com"));
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("activation tokens are stored only as hashes", () => {
  const { db, directory } = database();
  const memberId = addMember(db, "03");
  db.prepare("INSERT INTO member_profiles (member_id, activation_status) VALUES (?, 'pending')").run(memberId);
  const token = foundation.createActivationToken(db, memberId);
  const row = db.prepare("SELECT token_hash, used_at FROM member_activation_tokens WHERE member_id = ?").get(memberId);
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.equal(row.used_at, null);
  assert.equal(foundation.activateMember(db, token), memberId);
  assert.equal(db.prepare("SELECT activation_status FROM member_profiles WHERE member_id = ?").get(memberId).activation_status, "active");
  assert.throws(() => foundation.activateMember(db, token), /invalid or expired/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_events WHERE event_type = 'member_activated'").get().count, 1);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("issuing or using an activation token invalidates every older token", () => {
  const { db, directory } = database();
  const memberId = addMember(db, "08");
  db.prepare("INSERT INTO member_profiles (member_id, activation_status) VALUES (?, 'pending')").run(memberId);
  const first = foundation.createActivationToken(db, memberId);
  const second = foundation.createActivationToken(db, memberId);
  assert.throws(() => foundation.activateMember(db, first), /invalid or expired/);
  assert.equal(foundation.activateMember(db, second), memberId);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM member_activation_tokens WHERE member_id = ? AND used_at IS NULL").get(memberId).count, 0);
  assert.throws(() => foundation.createActivationToken(db, memberId), /not pending/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_events WHERE event_type = 'member_activated'").get().count, 1);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("feature flags remain off unless explicitly enabled", () => {
  const { db, directory } = database();
  assert.equal(foundation.featureEnabled(db, "member_self_registration"), false);
  db.prepare("UPDATE feature_flags SET enabled = 1 WHERE name = 'member_self_registration'").run();
  assert.equal(foundation.featureEnabled(db, "member_self_registration"), true);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("referrals reject self-reference and cycles while retaining replacement history", () => {
  const { db, directory } = database();
  const a = addMember(db, "04"); const b = addMember(db, "05"); const c = addMember(db, "06");
  foundation.setReferral(db, b, a, "test");
  foundation.setReferral(db, c, b, "test");
  assert.throws(() => foundation.setReferral(db, a, c, "test"), /cycle/);
  assert.throws(() => foundation.setReferral(db, a, a, "test"), /themselves/);
  foundation.setReferral(db, c, a, "test", null, "corrected");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM member_referrals WHERE member_id = ?").get(c).count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM member_referrals WHERE member_id = ? AND status = 'active'").get(c).count, 1);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("legacy stores, members and point records survive additive migrations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-legacy-test-"));
  const db = new DatabaseSync(path.join(directory, "legacy.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;"); db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  const store = db.prepare("INSERT INTO stores (store_name, contact_name, phone, email, platform_slug) VALUES ('舊分店','店長','02','old@example.com','old') RETURNING id").get();
  const memberId = addMember(db, "07", store.id);
  db.prepare("UPDATE members SET email = ' Member07@Example.COM ', phone = '+886 (912) 000-007' WHERE id = ?").run(memberId);
  db.prepare("INSERT INTO point_transactions (store_id, member_id, type, points, status) VALUES (?, ?, 'gift', 200, 'completed')").run(store.id, memberId);
  applyMigrations(db, path.join(root, "migrations"));
  assert.equal(db.prepare("SELECT store_id FROM members WHERE id = ?").get(memberId).store_id, store.id);
  assert.equal(db.prepare("SELECT points FROM point_transactions WHERE member_id = ?").get(memberId).points, 200);
  assert.deepEqual(
    { ...db.prepare("SELECT normalized_email, normalized_phone FROM member_profiles WHERE member_id = ?").get(memberId) },
    { normalized_email: "member07@example.com", normalized_phone: "0912000007" }
  );
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("legacy identity conflicts abort and roll back the identity migration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-conflict-test-"));
  const db = new DatabaseSync(path.join(directory, "conflict.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;"); db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  const firstStore = db.prepare("INSERT INTO stores (store_name, contact_name, phone, email, platform_slug) VALUES ('甲','甲','02','a@store.test','a') RETURNING id").get().id;
  const secondStore = db.prepare("INSERT INTO stores (store_name, contact_name, phone, email, platform_slug) VALUES ('乙','乙','03','b@store.test','b') RETURNING id").get().id;
  const first = addMember(db, "09", firstStore);
  const second = addMember(db, "10", secondStore);
  db.prepare("UPDATE members SET email = ' DUPLICATE@example.com ' WHERE id = ?").run(first);
  db.prepare("UPDATE members SET email = 'duplicate@EXAMPLE.com' WHERE id = ?").run(second);
  assert.throws(() => applyMigrations(db, path.join(root, "migrations")), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'member_profiles'").get(), undefined);
  assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version = '002_member_identity.sql'").get(), undefined);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("a legacy store using the reserved headquarters slug aborts the migration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-headquarters-conflict-"));
  const db = new DatabaseSync(path.join(directory, "conflict.sqlite"));
  db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  db.prepare("INSERT INTO stores (store_name, contact_name, phone, email, platform_slug) VALUES ('既有分店','店長','02','legacy@store.test','lt-headquarters')").run();
  assert.throws(() => applyMigrations(db, path.join(root, "migrations")), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version = '001_headquarters.sql'").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('stores') WHERE name = 'is_system_default'").get().count, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});
