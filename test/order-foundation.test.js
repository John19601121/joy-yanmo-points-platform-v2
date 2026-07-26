const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");
const foundation = require("../lib/order-foundation");
const ecpay = require("../lib/ecpay");

const root = path.join(__dirname, "..");

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-order-test-"));
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

function addActiveMember(db) {
  const storeId = db.prepare("SELECT id FROM stores WHERE is_system_default = 1").get().id;
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', '分享會員', '0912345678', 'sharer@example.test', 'hash', ?) RETURNING id`).get(storeId);
  const member = db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, 'LTTESTSHARER', '分享會員', '0912345678', 'sharer@example.test') RETURNING id, member_code`).get(storeId, user.id);
  db.prepare(`INSERT INTO member_profiles (member_id, activation_status)
    VALUES (?, 'active')`).run(member.id);
  return member;
}

function signedCallback(order, overrides = {}) {
  const credentials = { merchantId: "test-merchant", hashKey: "test-key", hashIv: "test-iv" };
  const payload = {
    MerchantID: credentials.merchantId,
    MerchantTradeNo: order.order_no,
    TradeNo: "2607261234567890",
    TradeAmt: String(order.total_amount),
    RtnCode: "1",
    RtnMsg: "Succeeded",
    PaymentDate: "2026/07/26 20:00:00",
    PaymentType: "Credit_CreditCard",
    SimulatePaid: "1",
    ...overrides
  };
  return {
    config: { ...credentials, mode: "stage", stageEnabled: true },
    payload: { ...payload, CheckMacValue: ecpay.createCheckMacValue(payload, credentials) }
  };
}

test("stage order snapshots price, distribution and optional sharer", () => {
  const { db, directory } = database();
  const sharer = addActiveMember(db);
  const created = foundation.createStageTestOrder(db, { sharerCode: "lttestsharer" });
  assert.equal(created.order.total_amount, 600);
  assert.equal(created.order.environment, "stage");
  assert.equal(created.order.is_test, 1);
  assert.equal(created.order.sharer_member_id, sharer.id);
  assert.deepEqual(JSON.parse(created.item.distribution_json), {
    supplier: 40, content: 20, sharer: 20, platform: 10, bonus_pool: 10
  });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_events WHERE order_id = ?").get(created.order.id).count, 1);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("successful signed callback pays once and creates five allocation snapshots", () => {
  const { db, directory } = database();
  const sharer = addActiveMember(db);
  const created = foundation.createStageTestOrder(db, { sharerCode: sharer.member_code });
  const callback = signedCallback(created.order);
  const first = foundation.applyEcpayCallback(db, callback.payload, callback.config);
  const second = foundation.applyEcpayCallback(db, callback.payload, callback.config);
  assert.equal(first.paid, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(created.order.id).payment_status, "paid");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_events WHERE order_id = ? AND provider = 'ecpay'").get(created.order.id).count, 1);
  const allocations = db.prepare("SELECT role, rate, amount, beneficiary_member_id FROM order_allocations WHERE order_id = ? ORDER BY role").all(created.order.id);
  assert.equal(allocations.length, 5);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.amount, 0), 600);
  assert.equal(allocations.find((allocation) => allocation.role === "sharer").beneficiary_member_id, sharer.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("callback rejects bad checksum, wrong amount and wrong merchant without changing the order", () => {
  const { db, directory } = database();
  const created = foundation.createStageTestOrder(db);
  const valid = signedCallback(created.order);
  assert.throws(() => foundation.applyEcpayCallback(
    db,
    { ...valid.payload, CheckMacValue: "0".repeat(64) },
    valid.config
  ), /CheckMacValue/);

  const wrongAmount = signedCallback(created.order, { TradeAmt: "601" });
  assert.throws(() => foundation.applyEcpayCallback(db, wrongAmount.payload, wrongAmount.config), /amount/);

  const wrongMerchant = signedCallback(created.order, { MerchantID: "other-merchant" });
  assert.throws(() => foundation.applyEcpayCallback(db, wrongMerchant.payload, wrongMerchant.config), /MerchantID/);
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(created.order.id).payment_status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_allocations WHERE order_id = ?").get(created.order.id).count, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("unassigned sharer allocation remains visible without inventing a beneficiary", () => {
  const { db, directory } = database();
  const created = foundation.createStageTestOrder(db);
  const callback = signedCallback(created.order);
  foundation.applyEcpayCallback(db, callback.payload, callback.config);
  const allocation = db.prepare("SELECT * FROM order_allocations WHERE order_id = ? AND role = 'sharer'").get(created.order.id);
  assert.equal(allocation.amount, 120);
  assert.equal(allocation.beneficiary_member_id, null);
  assert.equal(allocation.status, "unassigned");
  db.close(); fs.rmSync(directory, { recursive: true });
});
