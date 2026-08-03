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

function addActiveMember(db, {
  code = "LTTESTSHARER",
  name = "分享會員",
  phone = "0912345678",
  email = "sharer@example.test"
} = {}) {
  const storeId = db.prepare("SELECT id FROM stores WHERE is_system_default = 1").get().id;
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', ?, ?, ?, 'hash', ?) RETURNING id`).get(name, phone, email, storeId);
  const member = db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id, member_code`).get(storeId, user.id, code, name, phone, email);
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

function signedProductionCallback(order, overrides = {}) {
  const credentials = { merchantId: "3222651", hashKey: "production-key", hashIv: "production-iv" };
  const payload = {
    MerchantID: credentials.merchantId,
    MerchantTradeNo: order.order_no,
    TradeNo: "2608031234567890",
    TradeAmt: String(order.total_amount),
    RtnCode: "1",
    RtnMsg: "Succeeded",
    PaymentDate: "2026/08/03 20:00:00",
    PaymentType: "Credit_CreditCard",
    SimulatePaid: "0",
    ...overrides
  };
  return {
    config: {
      ...credentials,
      mode: "production",
      productionEnabled: true,
      productionMerchantApproved: true,
      creditEnabled: true
    },
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

test("successful signed callback pays once and creates complete allocation snapshots", () => {
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
  assert.equal(allocations.length, 7);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.amount, 0), 600);
  assert.equal(allocations.find((allocation) => allocation.role === "sharer").beneficiary_member_id, sharer.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("buyer referrer and product partner rewards come from the bonus pool without replacing the product sharer", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, {
    code: "LTTESTBUYER", name: "購買會員", phone: "0912000001", email: "buyer@example.test"
  });
  const permanentReferrer = addActiveMember(db, {
    code: "LTTESTPERMANENT", name: "永久推薦人", phone: "0912000002", email: "permanent@example.test"
  });
  const sharer = addActiveMember(db, {
    code: "LTTESTLINK", name: "商品分享人", phone: "0912000003", email: "link@example.test"
  });
  const partner = addActiveMember(db, {
    code: "LTTESTPARTNER", name: "合作引薦人", phone: "0912000004", email: "partner@example.test"
  });
  const memberFoundation = require("../lib/member-foundation");
  const referralSharing = require("../lib/referral-sharing");
  memberFoundation.setReferral(db, buyer.id, permanentReferrer.id, "test");
  const product = db.prepare("SELECT id FROM products WHERE product_code = 'SOAP001'").get();
  referralSharing.setProductPartnerReferral(db, {
    productId: product.id,
    referrerMemberId: partner.id,
    source: "test"
  });

  const created = foundation.createStageTestOrder(db, {
    buyerMemberCode: buyer.member_code,
    sharerCode: sharer.member_code,
    buyerName: "購買會員",
    buyerEmail: "buyer@example.test",
    buyerPhone: "0912000001"
  });
  assert.equal(created.order.sharer_member_id, sharer.id);
  assert.equal(created.order.buyer_referrer_member_id, permanentReferrer.id);
  assert.equal(created.item.partner_referrer_member_id, partner.id);
  foundation.applyEcpayCallback(db, signedCallback(created.order).payload, signedCallback(created.order).config);

  const allocations = db.prepare(`SELECT role, rate, amount, beneficiary_member_id
    FROM order_allocations WHERE order_id = ? ORDER BY role`).all(created.order.id);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.rate, 0), 100);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.amount, 0), 600);
  assert.deepEqual(
    Object.fromEntries(allocations.map((row) => [row.role, {
      rate: row.rate, amount: row.amount, beneficiary: row.beneficiary_member_id
    }])),
    {
      bonus_pool: { rate: 7, amount: 42, beneficiary: null },
      content: { rate: 20, amount: 120, beneficiary: null },
      member_referrer: { rate: 1, amount: 6, beneficiary: permanentReferrer.id },
      platform: { rate: 10, amount: 60, beneficiary: null },
      product_partner_referrer: { rate: 2, amount: 12, beneficiary: partner.id },
      sharer: { rate: 20, amount: 120, beneficiary: sharer.id },
      supplier: { rate: 40, amount: 240, beneficiary: null }
    }
  );
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("order snapshots keep the original referral even after an administrator changes the member relationship", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, {
    code: "LTBUYERSNAPSHOT", name: "快照購買人", phone: "0912000011", email: "snapshot-buyer@example.test"
  });
  const first = addActiveMember(db, {
    code: "LTFIRSTREF", name: "原推薦人", phone: "0912000012", email: "first-ref@example.test"
  });
  const second = addActiveMember(db, {
    code: "LTSECONDREF", name: "新推薦人", phone: "0912000013", email: "second-ref@example.test"
  });
  const memberFoundation = require("../lib/member-foundation");
  memberFoundation.setReferral(db, buyer.id, first.id, "test");
  const before = foundation.createStageTestOrder(db, { buyerMemberCode: buyer.member_code });
  memberFoundation.setReferral(db, buyer.id, second.id, "admin", null, "資料更正");
  const after = foundation.createStageTestOrder(db, { buyerMemberCode: buyer.member_code });
  assert.equal(before.order.buyer_referrer_member_id, first.id);
  assert.equal(after.order.buyer_referrer_member_id, second.id);
  assert.equal(db.prepare("SELECT buyer_referrer_member_id FROM orders WHERE id = ?").get(before.order.id).buyer_referrer_member_id, first.id);
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

test("production trial offer snapshots NT$200 merchandise plus NT$65 shipping without allocating shipping", () => {
  const { db, directory } = database();
  const sharer = addActiveMember(db);
  const created = foundation.createProductionOrder(db, {
    productCode: "SOAP001",
    offerCode: "trial_1",
    buyerName: "正式測試買家",
    buyerEmail: "buyer@example.test",
    buyerPhone: "0911000000",
    receiverName: "正式測試收件人",
    receiverPhone: "0911000000",
    shippingPostalCode: "104",
    shippingAddress: "台北市中山區測試路1號",
    sharerCode: sharer.member_code,
    checkoutToken: "production-checkout-token-00000001"
  });
  assert.equal(created.order.environment, "production");
  assert.equal(created.order.is_test, 0);
  assert.equal(created.order.subtotal_amount, 200);
  assert.equal(created.order.shipping_amount, 65);
  assert.equal(created.order.total_amount, 265);
  assert.equal(created.item.line_total, 200);
  assert.equal(created.item.paid_quantity, 1);
  assert.equal(created.item.bonus_quantity, 0);

  const callback = signedProductionCallback(created.order);
  foundation.applyEcpayCallback(db, callback.payload, callback.config);
  const allocations = db.prepare("SELECT role, amount FROM order_allocations WHERE order_id = ?").all(created.order.id);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.amount, 0), 200);
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(created.order.id).payment_status, "paid");
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("production callback rejects simulated payment and leaves order pending", () => {
  const { db, directory } = database();
  const created = foundation.createProductionOrder(db, {
    buyerName: "正式測試買家",
    buyerEmail: "buyer@example.test",
    buyerPhone: "0911000000",
    receiverName: "正式測試收件人",
    receiverPhone: "0911000000",
    shippingAddress: "台北市中山區測試路1號",
    checkoutToken: "production-checkout-token-00000002"
  });
  const callback = signedProductionCallback(created.order, { SimulatePaid: "1" });
  assert.throws(
    () => foundation.applyEcpayCallback(db, callback.payload, callback.config),
    /Simulated.*production/
  );
  assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(created.order.id).payment_status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_allocations WHERE order_id = ?").get(created.order.id).count, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("repeated production checkout token reuses the pending order instead of duplicating it", () => {
  const { db, directory } = database();
  const input = {
    buyerName: "防重送測試買家",
    buyerEmail: "dedupe@example.test",
    buyerPhone: "0911000001",
    receiverName: "防重送測試收件人",
    receiverPhone: "0911000001",
    shippingAddress: "台北市中山區測試路二號",
    checkoutToken: "production-checkout-token-00000003"
  };
  const first = foundation.createProductionOrder(db, input);
  const second = foundation.createProductionOrder(db, input);
  assert.equal(first.reused, undefined);
  assert.equal(second.reused, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE environment = 'production'").get().count, 1);
  db.close(); fs.rmSync(directory, { recursive: true });
});
