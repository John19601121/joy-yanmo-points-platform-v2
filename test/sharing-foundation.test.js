const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");
const sharing = require("../lib/sharing-foundation");
const members = require("../lib/member-foundation");

const root = path.join(__dirname, "..");

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-sharing-test-"));
  const db = new DatabaseSync(path.join(directory, "test.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  applyMigrations(db, path.join(root, "migrations"));
  return { db, directory };
}

function addActiveMember(db, suffix) {
  const storeId = members.headquartersId(db);
  const email = `member${suffix}@example.test`;
  const phone = `0912${String(suffix).padStart(6, "0")}`;
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', ?, ?, ?, 'hash', ?) RETURNING id`).get(`會員${suffix}`, phone, email, storeId);
  const member = db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id, member_code`).get(
      storeId, user.id, `LTTEST${suffix}`, `會員${suffix}`, phone, email
    );
  db.prepare(`INSERT INTO member_profiles
    (member_id, normalized_email, normalized_phone, activation_status)
    VALUES (?, ?, ?, 'active')`).run(member.id, email, phone);
  return member;
}

function addProduct(db) {
  const type = db.prepare("INSERT INTO product_types (name) VALUES ('用品') RETURNING id").get();
  return db.prepare(`INSERT INTO products
    (product_code, name, type_id, product_page_url, is_active)
    VALUES ('TEST001', '測試商品', ?, 'https://example.test/product', 1) RETURNING id`).get(type.id);
}

test("event registration creates a 30-day prospect protection, not a sales allocation", () => {
  const { db, directory } = database();
  const sharer = addActiveMember(db, "01");
  const event = sharing.createEvent(db, { eventCode: "EVT01", title: "活動一" });
  const link = sharing.createShareLink(db, {
    sharerMemberId: sharer.id,
    linkType: "event",
    eventId: event.id,
    token: "event-token-01"
  });
  const now = new Date("2026-07-28T00:00:00Z");
  const result = sharing.registerForEvent(db, {
    eventId: event.id,
    shareToken: link.token,
    attendeeName: "潛在會員",
    email: "prospect@example.test",
    phone: "0912888888",
    now
  });
  assert.equal(result.protection.protected_by_member_id, sharer.id);
  assert.equal(result.protection.expires_at, "2026-08-27 00:00:00");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_allocations").get().count, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("the first active event protection cannot be overwritten by another member", () => {
  const { db, directory } = database();
  const first = addActiveMember(db, "02");
  const second = addActiveMember(db, "03");
  const event = sharing.createEvent(db, { eventCode: "EVT02", title: "活動二" });
  const firstLink = sharing.createShareLink(db, {
    sharerMemberId: first.id, linkType: "event", eventId: event.id, token: "first-event-link"
  });
  const secondLink = sharing.createShareLink(db, {
    sharerMemberId: second.id, linkType: "event", eventId: event.id, token: "second-event-link"
  });
  const now = new Date("2026-07-28T00:00:00Z");
  sharing.registerForEvent(db, {
    eventId: event.id, shareToken: firstLink.token, attendeeName: "E",
    email: "protected@example.test", now
  });
  const repeated = sharing.registerForEvent(db, {
    eventId: event.id, shareToken: secondLink.token, attendeeName: "E",
    email: "protected@example.test", now: new Date("2026-08-01T00:00:00Z")
  });
  assert.equal(repeated.protectedByExisting, true);
  assert.equal(repeated.protection.protected_by_member_id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM prospect_protections").get().count, 1);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("registration during protection permanently binds the protected referrer and ignores a competing code", () => {
  const { db, directory } = database();
  const protectedBy = addActiveMember(db, "04");
  const competing = addActiveMember(db, "05");
  const event = sharing.createEvent(db, { eventCode: "EVT03", title: "活動三" });
  const link = sharing.createShareLink(db, {
    sharerMemberId: protectedBy.id, linkType: "event", eventId: event.id, token: "protected-link"
  });
  sharing.registerForEvent(db, {
    eventId: event.id,
    shareToken: link.token,
    attendeeName: "新會員",
    email: "new-member@example.test",
    phone: "0912777777",
    now: new Date("2026-07-28T00:00:00Z")
  });
  const registered = members.registerPendingMember(db, {
    name: "新會員",
    email: "new-member@example.test",
    phone: "0912777777",
    memberCode: "LTNEW0001",
    temporaryPasswordHash: "hash",
    referralCode: competing.member_code,
    now: new Date("2026-08-05T00:00:00Z")
  });
  assert.equal(registered.referrerMemberId, protectedBy.id);
  assert.ok(registered.protectionId);
  assert.equal(
    db.prepare("SELECT referrer_member_id FROM member_referrals WHERE member_id = ? AND status = 'active'").get(registered.memberId).referrer_member_id,
    protectedBy.id
  );
  assert.equal(
    db.prepare("SELECT status FROM prospect_protections WHERE id = ?").get(registered.protectionId).status,
    "converted"
  );
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("expired protection reopens the relationship", () => {
  const { db, directory } = database();
  const first = addActiveMember(db, "06");
  const second = addActiveMember(db, "07");
  const event = sharing.createEvent(db, { eventCode: "EVT04", title: "活動四" });
  const link = sharing.createShareLink(db, {
    sharerMemberId: first.id, linkType: "event", eventId: event.id, token: "expired-link"
  });
  sharing.registerForEvent(db, {
    eventId: event.id, shareToken: link.token, attendeeName: "到期名單",
    phone: "0912666666", now: new Date("2026-01-01T00:00:00Z")
  });
  const registered = members.registerPendingMember(db, {
    name: "到期名單",
    email: "expired@example.test",
    phone: "0912666666",
    memberCode: "LTNEW0002",
    temporaryPasswordHash: "hash",
    referralCode: second.member_code,
    now: new Date("2026-02-01T00:00:01Z")
  });
  assert.equal(registered.referrerMemberId, second.id);
  assert.equal(registered.protectionId, null);
  assert.equal(db.prepare("SELECT status FROM prospect_protections").get().status, "expired");
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("an existing member event registration never changes permanent referral", () => {
  const { db, directory } = database();
  const original = addActiveMember(db, "08");
  const attendee = addActiveMember(db, "09");
  const other = addActiveMember(db, "10");
  members.setReferral(db, attendee.id, original.id, "test");
  const event = sharing.createEvent(db, { eventCode: "EVT05", title: "活動五" });
  const link = sharing.createShareLink(db, {
    sharerMemberId: other.id, linkType: "event", eventId: event.id, token: "existing-member-link"
  });
  const result = sharing.registerForEvent(db, {
    eventId: event.id,
    shareToken: link.token,
    attendeeName: "既有會員",
    email: "member09@example.test",
    phone: "0912000009"
  });
  assert.equal(result.existingMember, true);
  assert.equal(result.protection, null);
  assert.equal(
    db.prepare("SELECT referrer_member_id FROM member_referrals WHERE member_id = ? AND status = 'active'").get(attendee.id).referrer_member_id,
    original.id
  );
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("product introducer replacement retains history and only one active relation", () => {
  const { db, directory } = database();
  const first = addActiveMember(db, "11");
  const second = addActiveMember(db, "12");
  const product = addProduct(db);
  sharing.setProductIntroducer(db, product.id, first.id, { reason: "initial" });
  sharing.setProductIntroducer(db, product.id, second.id, { reason: "admin correction" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_referrals WHERE product_id = ?").get(product.id).count, 2);
  assert.equal(sharing.activeProductIntroducer(db, product.id).introducer_member_id, second.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});
