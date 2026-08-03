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

function addActiveMember(db, suffix = "SHARER") {
  const storeId = db.prepare("SELECT id FROM stores WHERE is_system_default = 1").get().id;
  const digits = String(suffix).replace(/\D/g, "").padStart(2, "0").slice(-2);
  const email = `${String(suffix).toLowerCase()}@example.test`;
  const phone = `09123456${digits}`;
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', ?, ?, ?, 'hash', ?) RETURNING id`).get(`會員${suffix}`, phone, email, storeId);
  const member = db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id, member_code`).get(
      storeId, user.id, `LTTEST${suffix}`, `會員${suffix}`, phone, email
    );
  db.prepare(`INSERT INTO member_profiles (member_id, normalized_email, normalized_phone, activation_status)
    VALUES (?, ?, ?, 'active')`).run(member.id, email, phone);
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
    config: { ...credentials, mode: "stage", stageEnabled: true, callbackEnabled: true },
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
      callbackEnabled: true,
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

test("paid order snapshots independent 20%, 1% and 2% relationships from the bonus pool", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, "01");
  const sharer = addActiveMember(db, "02");
  const referrer = addActiveMember(db, "03");
  const introducer = addActiveMember(db, "04");
  const productId = db.prepare("SELECT id FROM products WHERE product_code = 'SOAP001'").get().id;
  db.prepare(`INSERT INTO member_referrals (member_id, referrer_member_id, source)
    VALUES (?, ?, 'test')`).run(buyer.id, referrer.id);
  db.prepare(`INSERT INTO product_referrals (product_id, introducer_member_id)
    VALUES (?, ?)`).run(productId, introducer.id);

  const created = foundation.createStageTestOrder(db, {
    buyerMemberCode: buyer.member_code,
    sharerCode: sharer.member_code
  });
  assert.equal(created.order.sharer_member_id, sharer.id);
  assert.equal(created.order.referrer_member_id_snapshot, referrer.id);
  assert.equal(created.item.product_introducer_member_id_snapshot, introducer.id);

  const callback = signedCallback(created.order);
  foundation.applyEcpayCallback(db, callback.payload, callback.config);
  const allocations = db.prepare(`SELECT role, rate, amount, beneficiary_member_id
    FROM order_allocations WHERE order_id = ? ORDER BY role`).all(created.order.id);
  assert.equal(allocations.length, 7);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.amount, 0), 600);
  assert.deepEqual(Object.fromEntries(allocations.map((row) => [row.role, row.rate])), {
    bonus_pool: 7,
    content: 20,
    member_referral: 1,
    platform: 10,
    product_introducer: 2,
    sharer: 20,
    supplier: 40
  });
  assert.equal(allocations.find((row) => row.role === "sharer").beneficiary_member_id, sharer.id);
  assert.equal(allocations.find((row) => row.role === "member_referral").beneficiary_member_id, referrer.id);
  assert.equal(allocations.find((row) => row.role === "product_introducer").beneficiary_member_id, introducer.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("later administrator relationship changes never rewrite an existing order snapshot", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, "05");
  const original = addActiveMember(db, "06");
  const replacement = addActiveMember(db, "07");
  db.prepare(`INSERT INTO member_referrals (member_id, referrer_member_id, source)
    VALUES (?, ?, 'test')`).run(buyer.id, original.id);
  const created = foundation.createStageTestOrder(db, { buyerMemberCode: buyer.member_code });
  db.prepare("UPDATE member_referrals SET status = 'replaced', ended_at = CURRENT_TIMESTAMP WHERE member_id = ?").run(buyer.id);
  db.prepare(`INSERT INTO member_referrals (member_id, referrer_member_id, source)
    VALUES (?, ?, 'admin')`).run(buyer.id, replacement.id);
  foundation.applyEcpayCallback(db, signedCallback(created.order).payload, signedCallback(created.order).config);
  const referralAllocation = db.prepare(`SELECT beneficiary_member_id
    FROM order_allocations WHERE order_id = ? AND role = 'member_referral'`).get(created.order.id);
  assert.equal(referralAllocation.beneficiary_member_id, original.id);
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

test("production checkout keeps PR #7 referral and product-introducer snapshots", () => {
  const { db, directory } = database();
  const buyer = addActiveMember(db, "11");
  const sharer = addActiveMember(db, "12");
  const referrer = addActiveMember(db, "13");
  const introducer = addActiveMember(db, "14");
  const productId = db.prepare("SELECT id FROM products WHERE product_code = 'SOAP001'").get().id;
  db.prepare(`INSERT INTO member_referrals (member_id, referrer_member_id, source)
    VALUES (?, ?, 'test')`).run(buyer.id, referrer.id);
  db.prepare(`INSERT INTO product_referrals (product_id, introducer_member_id)
    VALUES (?, ?)`).run(productId, introducer.id);

  const created = foundation.createProductionOrder(db, {
    buyerMemberCode: buyer.member_code,
    buyerName: "正式會員買家",
    buyerEmail: "buyer11@example.test",
    buyerPhone: "0911000011",
    receiverName: "正式會員買家",
    receiverPhone: "0911000011",
    shippingAddress: "台北市中山區測試路11號",
    sharerCode: sharer.member_code,
    checkoutToken: "production-checkout-token-00000011"
  });
  assert.equal(created.order.referrer_member_id_snapshot, referrer.id);
  assert.equal(created.item.product_introducer_member_id_snapshot, introducer.id);
  foundation.applyEcpayCallback(db, signedProductionCallback(created.order).payload, signedProductionCallback(created.order).config);
  const allocations = db.prepare("SELECT role, amount, beneficiary_member_id FROM order_allocations WHERE order_id = ?").all(created.order.id);
  assert.equal(allocations.reduce((sum, row) => sum + row.amount, 0), 200);
  assert.equal(allocations.find((row) => row.role === "member_referral").beneficiary_member_id, referrer.id);
  assert.equal(allocations.find((row) => row.role === "product_introducer").beneficiary_member_id, introducer.id);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("production checkout rejects email and phone belonging to different active members", () => {
  const { db, directory } = database();
  addActiveMember(db, "21");
  addActiveMember(db, "22");
  assert.throws(() => foundation.createProductionOrder(db, {
    buyerName: "身分衝突測試",
    buyerEmail: "21@example.test",
    buyerPhone: "0912345622",
    receiverName: "身分衝突測試",
    receiverPhone: "0912345622",
    shippingAddress: "台北市中山區測試路21號",
    checkoutToken: "production-checkout-token-identity-conflict"
  }), /email and phone belong to different active members/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM orders WHERE environment = 'production'").get().count, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("a pending Production order still settles after new collection is disabled", () => {
  const { db, directory } = database();
  const created = foundation.createProductionOrder(db, {
    buyerName: "正式回傳測試",
    buyerEmail: "callback@example.test",
    buyerPhone: "0911000023",
    receiverName: "正式回傳測試",
    receiverPhone: "0911000023",
    shippingAddress: "台北市中山區測試路23號",
    checkoutToken: "production-checkout-token-disabled-callback"
  });
  const signed = signedProductionCallback(created.order);
  const callbackConfig = ecpay.paymentConfigForMerchantId("3222651", {
    ECPAY_MODE: "production",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_MERCHANT_ID: "3222651",
    ECPAY_PRODUCTION_HASH_KEY: "production-key",
    ECPAY_PRODUCTION_HASH_IV: "production-iv",
    ECPAY_PRODUCTION_CREDIT_ENABLED: "false"
  });
  const result = foundation.applyEcpayCallback(db, signed.payload, callbackConfig);
  assert.equal(result.paid, true);
  assert.equal(result.order.payment_status, "paid");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM order_allocations WHERE order_id = ?").get(created.order.id).count, 5);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("a pending Stage order still settles after Production mode is selected", () => {
  const { db, directory } = database();
  const created = foundation.createStageTestOrder(db);
  const signed = signedCallback(created.order);
  const callbackConfig = ecpay.paymentConfigForMerchantId("test-merchant", {
    ECPAY_MODE: "production",
    ECPAY_STAGE_ENABLED: "false",
    ECPAY_MERCHANT_ID: "test-merchant",
    ECPAY_HASH_KEY: "test-key",
    ECPAY_HASH_IV: "test-iv",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_MERCHANT_ID: "3222651",
    ECPAY_PRODUCTION_HASH_KEY: "production-key",
    ECPAY_PRODUCTION_HASH_IV: "production-iv"
  });
  const result = foundation.applyEcpayCallback(db, signed.payload, callbackConfig);
  assert.equal(callbackConfig.mode, "stage");
  assert.equal(result.paid, true);
  assert.equal(result.order.payment_status, "paid");
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
