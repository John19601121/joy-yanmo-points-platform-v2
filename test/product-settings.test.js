const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");
const productSettings = require("../lib/product-settings");
const orderFoundation = require("../lib/order-foundation");
const ecpay = require("../lib/ecpay");

const root = path.join(__dirname, "..");
const standardDistribution = {
  supplier: 40,
  content: 20,
  sharer: 20,
  platform: 10,
  member_referral: 1,
  product_introducer: 2,
  bonus_pool: 7
};

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-product-settings-test-"));
  const db = new DatabaseSync(path.join(directory, "test.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  const type = db.prepare("INSERT INTO product_types (name) VALUES ('用品') RETURNING id").get();
  const product = db.prepare(`INSERT INTO products
    (product_code, name, type_id, product_page_url, is_active)
    VALUES ('SOAP001', '菱烏金炭皂', ?, 'https://example.test/soap', 1)
    RETURNING id`).get(type.id);
  applyMigrations(db, path.join(root, "migrations"));
  return { db, directory, productId: product.id };
}

function addActiveMember(db, suffix) {
  const storeId = db.prepare("SELECT id FROM stores WHERE is_system_default = 1").get().id;
  const digits = String(suffix).replace(/\D/g, "").padStart(2, "0").slice(-2);
  const email = `${String(suffix).toLowerCase()}@example.test`;
  const phone = `09223344${digits}`;
  const user = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', ?, ?, ?, 'hash', ?) RETURNING id`).get(`會員${suffix}`, phone, email, storeId);
  const member = db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id, member_code`).get(
      storeId, user.id, `LTSET${suffix}`, `會員${suffix}`, phone, email
    );
  db.prepare(`INSERT INTO member_profiles (member_id, normalized_email, normalized_phone, activation_status)
    VALUES (?, ?, ?, 'active')`).run(member.id, email, phone);
  return member;
}

function signedCallback(order) {
  const config = {
    merchantId: "test-merchant",
    hashKey: "test-key",
    hashIv: "test-iv",
    mode: "stage",
    stageEnabled: true,
    callbackEnabled: true
  };
  const payload = {
    MerchantID: config.merchantId,
    MerchantTradeNo: order.order_no,
    TradeNo: "2608051234567890",
    TradeAmt: String(order.total_amount),
    RtnCode: "1",
    RtnMsg: "Succeeded",
    PaymentDate: "2026/08/05 12:00:00",
    PaymentType: "Credit_CreditCard",
    SimulatePaid: "1"
  };
  return { config, payload: { ...payload, CheckMacValue: ecpay.createCheckMacValue(payload, config) } };
}

test("migration retires the hard-coded Stage price and selects the real trial offer", () => {
  const { db, directory, productId } = database();
  const config = db.prepare("SELECT * FROM product_checkout_configs WHERE product_id = ?").get(productId);
  assert.equal(config.stage_price, null);
  assert.equal(config.stage_offer_code, "trial_1");
  assert.deepEqual(JSON.parse(config.distribution_json), standardDistribution);
  assert.equal(db.prepare("SELECT price FROM products WHERE id = ?").get(productId).price, 600);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("Stage reads the exact merchandise, shipping and distribution saved in the product offer", () => {
  const { db, directory, productId } = database();
  productSettings.saveOffer(db, {
    productId,
    offerCode: "stage_verified",
    displayName: "Stage 同源方案",
    paidQuantity: 2,
    bonusQuantity: 1,
    merchandiseAmount: 450,
    shippingAmount: 80,
    distribution: standardDistribution
  });
  productSettings.saveStageSelection(db, {
    productId,
    offerCode: "stage_verified",
    enabled: true
  });
  const created = orderFoundation.createStageTestOrder(db);
  assert.equal(created.order.offer_code, "stage_verified");
  assert.equal(created.order.subtotal_amount, 450);
  assert.equal(created.order.shipping_amount, 80);
  assert.equal(created.order.total_amount, 530);
  assert.equal(created.item.line_total, 450);
  assert.equal(created.item.paid_quantity, 2);
  assert.equal(created.item.bonus_quantity, 1);
  assert.deepEqual(JSON.parse(created.item.distribution_json), standardDistribution);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("product people settings are snapshotted and paid to the configured members", () => {
  const { db, directory, productId } = database();
  const supplier = addActiveMember(db, "01");
  const content = addActiveMember(db, "02");
  const platform = addActiveMember(db, "03");
  const introducer = addActiveMember(db, "04");
  const buyer = addActiveMember(db, "05");
  const referrer = addActiveMember(db, "06");
  const sharer = addActiveMember(db, "07");
  db.prepare(`INSERT INTO member_referrals (member_id, referrer_member_id, source)
    VALUES (?, ?, 'test')`).run(buyer.id, referrer.id);
  productSettings.savePeople(db, {
    productId,
    supplierCode: supplier.member_code,
    contentCode: content.member_code,
    platformCode: platform.member_code,
    productIntroducerCode: introducer.member_code
  });

  const created = orderFoundation.createStageTestOrder(db, {
    buyerMemberCode: buyer.member_code,
    sharerCode: sharer.member_code
  });
  assert.equal(created.item.supplier_member_id_snapshot, supplier.id);
  assert.equal(created.item.content_member_id_snapshot, content.id);
  assert.equal(created.item.platform_member_id_snapshot, platform.id);
  assert.equal(created.item.product_introducer_member_id_snapshot, introducer.id);
  const signed = signedCallback(created.order);
  orderFoundation.applyEcpayCallback(db, signed.payload, signed.config);
  const allocations = db.prepare(`SELECT role, beneficiary_member_id, amount
    FROM order_allocations WHERE order_id = ?`).all(created.order.id);
  assert.deepEqual(Object.fromEntries(allocations.map((row) => [row.role, row.beneficiary_member_id])), {
    supplier: supplier.id,
    content: content.id,
    sharer: sharer.id,
    platform: platform.id,
    member_referral: referrer.id,
    product_introducer: introducer.id,
    bonus_pool: null
  });
  assert.equal(allocations.reduce((sum, row) => sum + row.amount, 0), 200);
  db.close(); fs.rmSync(directory, { recursive: true });
});

test("invalid seven-role distribution or member codes cannot partially change product settings", () => {
  const { db, directory, productId } = database();
  assert.throws(() => productSettings.saveOffer(db, {
    productId,
    offerCode: "bad_rates",
    displayName: "錯誤比例",
    paidQuantity: 1,
    bonusQuantity: 0,
    merchandiseAmount: 200,
    shippingAmount: 65,
    distribution: { ...standardDistribution, bonus_pool: 8 }
  }), /合計必須為 100/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_checkout_offers WHERE offer_code = 'bad_rates'").get().count, 0);
  assert.throws(() => productSettings.savePeople(db, {
    productId,
    supplierCode: "NOT-A-MEMBER"
  }), /供應商會員編號無效/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_revenue_beneficiaries WHERE product_id = ?").get(productId).count, 0);
  db.close(); fs.rmSync(directory, { recursive: true });
});
