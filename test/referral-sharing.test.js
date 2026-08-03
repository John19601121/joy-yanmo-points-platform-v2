const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");
const memberFoundation = require("../lib/member-foundation");
const referralSharing = require("../lib/referral-sharing");

const root = path.join(__dirname, "..");

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-referral-sharing-"));
  const db = new DatabaseSync(path.join(directory, "test.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  const type = db.prepare("INSERT INTO product_types (name) VALUES ('用品') RETURNING id").get();
  db.prepare(`INSERT INTO products
    (product_code, name, type_id, product_page_url, price, is_active)
    VALUES ('SOAP001', '菱烏金炭皂', ?, 'https://example.test/soap', NULL, 1)`).run(type.id);
  applyMigrations(db, path.join(root, "migrations"));
  return { db, directory };
}

function addActiveMember(db, suffix) {
  const storeId = db.prepare("SELECT id FROM stores WHERE is_system_default = 1").get().id;
  const phone = `0912${String(suffix).padStart(6, "0")}`;
  const email = `member${suffix}@example.test`;
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', ?, ?, ?, 'hash', ?) RETURNING id`).get(`會員${suffix}`, phone, email, storeId);
  const member = db.prepare(`INSERT INTO members
    (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id, member_code, name, email, phone`)
    .get(storeId, user.id, `LTTEST${suffix}`, `會員${suffix}`, phone, email);
  db.prepare(`INSERT INTO member_profiles
    (member_id, normalized_email, normalized_phone, activation_status)
    VALUES (?, ?, ?, 'active')`).run(member.id, email, phone);
  return member;
}

test("a product share never replaces the buyer permanent referrer", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, 1);
  const permanentReferrer = addActiveMember(db, 2);
  const productSharer = addActiveMember(db, 3);
  memberFoundation.setReferral(db, buyer.id, permanentReferrer.id, "registration");
  const product = db.prepare("SELECT id FROM products WHERE product_code = 'SOAP001'").get();
  const resolved = referralSharing.resolveOrderAttribution(db, {
    productId: product.id,
    explicitSharerCode: productSharer.member_code,
    buyerMemberId: buyer.id,
    buyerEmail: buyer.email,
    buyerPhone: buyer.phone
  });
  assert.equal(resolved.sharer.id, productSharer.id);
  assert.equal(resolved.buyerReferrer.referrer_member_id, permanentReferrer.id);
  assert.equal(referralSharing.activeReferralForMember(db, buyer.id).referrer_member_id, permanentReferrer.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("event registration creates a 30-day temporary attribution without changing an existing referral", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, 11);
  const permanentReferrer = addActiveMember(db, 12);
  const eventSharer = addActiveMember(db, 13);
  const productSharer = addActiveMember(db, 14);
  memberFoundation.setReferral(db, buyer.id, permanentReferrer.id, "registration");
  db.prepare(`INSERT INTO events (event_code, name, is_active)
    VALUES ('FRIDAY001', '週五產品發表會', 1)`).run();
  const clickedAt = new Date("2026-07-01T00:00:00Z");
  const shared = referralSharing.createShareAttribution(db, {
    kind: "event",
    referrerCode: eventSharer.member_code,
    eventCode: "FRIDAY001",
    now: clickedAt
  });
  const registration = referralSharing.registerEventParticipant(db, {
    eventCode: "FRIDAY001",
    name: buyer.name,
    email: buyer.email,
    phone: buyer.phone,
    attributionToken: shared.attribution.attribution_token,
    now: clickedAt
  });
  assert.equal(registration.registration.temporary_referrer_member_id, eventSharer.id);
  assert.equal(registration.registration.attribution_expires_at, "2026-07-31T00:00:00.000Z");
  assert.equal(referralSharing.activeReferralForMember(db, buyer.id).referrer_member_id, permanentReferrer.id);

  const product = db.prepare("SELECT id FROM products WHERE product_code = 'SOAP001'").get();
  const withinWindow = referralSharing.resolveOrderAttribution(db, {
    productId: product.id,
    buyerMemberId: buyer.id,
    buyerEmail: buyer.email,
    buyerPhone: buyer.phone,
    now: new Date("2026-07-30T23:59:59Z")
  });
  assert.equal(withinWindow.sharer.id, eventSharer.id);
  assert.equal(withinWindow.buyerReferrer.referrer_member_id, permanentReferrer.id);

  const afterWindow = referralSharing.resolveOrderAttribution(db, {
    productId: product.id,
    buyerMemberId: buyer.id,
    buyerEmail: buyer.email,
    buyerPhone: buyer.phone,
    now: new Date("2026-08-01T00:00:00Z")
  });
  assert.equal(afterWindow.sharer, null);
  assert.equal(afterWindow.buyerReferrer.referrer_member_id, permanentReferrer.id);

  const explicitProductLinkWins = referralSharing.resolveOrderAttribution(db, {
    productId: product.id,
    explicitSharerCode: productSharer.member_code,
    buyerMemberId: buyer.id,
    buyerEmail: buyer.email,
    buyerPhone: buyer.phone,
    now: new Date("2026-07-15T00:00:00Z")
  });
  assert.equal(explicitProductLinkWins.sharer.id, productSharer.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("share tokens reject mismatched products and inactive or expired sources", () => {
  const { db, directory } = database();
  const sharer = addActiveMember(db, 21);
  const secondType = db.prepare("SELECT id FROM product_types LIMIT 1").get();
  db.prepare(`INSERT INTO products
    (product_code, name, type_id, product_page_url, is_active)
    VALUES ('OTHER001', '其他商品', ?, 'https://example.test/other', 1)`).run(secondType.id);
  const shared = referralSharing.createShareAttribution(db, {
    kind: "product",
    referrerCode: sharer.member_code,
    productCode: "SOAP001",
    now: new Date("2026-07-01T00:00:00Z")
  });
  const other = db.prepare("SELECT id FROM products WHERE product_code = 'OTHER001'").get();
  assert.throws(() => referralSharing.resolveOrderAttribution(db, {
    productId: other.id,
    attributionToken: shared.attribution.attribution_token,
    now: new Date("2026-07-02T00:00:00Z")
  }), /does not belong/);
  assert.equal(referralSharing.activeAttributionByToken(
    db,
    shared.attribution.attribution_token,
    new Date("2026-08-01T00:00:00Z")
  ), null);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("an event click alone does not create a temporary sales attribution before registration", () => {
  const { db, directory } = database();
  const sharer = addActiveMember(db, 31);
  db.prepare("INSERT INTO events (event_code, name, is_active) VALUES ('CLICKONLY', '僅點擊活動', 1)").run();
  const shared = referralSharing.createShareAttribution(db, {
    kind: "event",
    referrerCode: sharer.member_code,
    eventCode: "CLICKONLY",
    now: new Date("2026-07-01T00:00:00Z")
  });
  const product = db.prepare("SELECT id FROM products WHERE product_code = 'SOAP001'").get();
  const resolved = referralSharing.resolveOrderAttribution(db, {
    productId: product.id,
    attributionToken: shared.attribution.attribution_token,
    now: new Date("2026-07-02T00:00:00Z")
  });
  assert.equal(resolved.sharer, null);
  db.close(); fs.rmSync(directory, { recursive: true });
});
