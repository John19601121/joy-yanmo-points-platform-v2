const crypto = require("node:crypto");
const ecpay = require("./ecpay");
const sharingFoundation = require("./sharing-foundation");

const LEGACY_DISTRIBUTION_ROLES = ["supplier", "content", "sharer", "platform", "bonus_pool"];
const DISTRIBUTION_ROLES = [
  "supplier", "content", "sharer", "platform",
  "member_referral", "product_introducer", "bonus_pool"
];
const ALLOCATION_ROLES = [
  "supplier", "content", "sharer", "platform",
  "member_referral", "product_introducer", "bonus_pool"
];

function distributionValue(value) {
  let distribution;
  try {
    distribution = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Product distribution is invalid.");
  }
  if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) {
    throw new Error("Product distribution is invalid.");
  }
  return distribution;
}

function hasExplicitRelationshipRates(value) {
  const distribution = distributionValue(value);
  return Object.hasOwn(distribution, "member_referral") || Object.hasOwn(distribution, "product_introducer");
}

function parseDistribution(value) {
  const distribution = distributionValue(value);
  const explicitRelationships = hasExplicitRelationshipRates(distribution);
  if (explicitRelationships && (!Object.hasOwn(distribution, "member_referral") || !Object.hasOwn(distribution, "product_introducer"))) {
    throw new Error("Product relationship distribution is incomplete.");
  }
  const roles = explicitRelationships ? DISTRIBUTION_ROLES : LEGACY_DISTRIBUTION_ROLES;
  const normalized = Object.fromEntries(roles.map((role) => {
    const rate = Number(distribution[role]);
    if (!Number.isInteger(rate) || rate < 0 || rate > 100) throw new Error(`Product distribution rate is invalid: ${role}.`);
    return [role, rate];
  }));
  if (Object.values(normalized).reduce((sum, rate) => sum + rate, 0) !== 100) {
    throw new Error("Product distribution must total 100 percent.");
  }
  return normalized;
}

function generateOrderNo(now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(2, 14);
  const suffix = crypto.randomInt(0, 10000).toString().padStart(4, "0");
  return `LT${stamp}${suffix}`;
}

function activeMemberByCode(db, memberCode) {
  const code = String(memberCode || "").trim().toUpperCase();
  if (!code) return null;
  return db.prepare(`SELECT members.id, members.member_code, members.name
    FROM members
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles ON member_profiles.member_id = members.id
    WHERE members.member_code = ?
      AND users.status = 'active'
      AND COALESCE(member_profiles.activation_status, 'active') = 'active'
    LIMIT 1`).get(code) || null;
}

function activeMemberByIdentity(db, { memberCode = "", email = "", phone = "" } = {}) {
  const byCode = activeMemberByCode(db, memberCode);
  if (memberCode) return byCode;
  const normalizedEmail = sharingFoundation.normalizeEmail(email);
  const normalizedPhone = sharingFoundation.normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone) return null;
  const findActiveMember = (column, value) => value ? db.prepare(`SELECT members.id, members.member_code, members.name
    FROM members
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles profiles ON profiles.member_id = members.id
    WHERE users.status = 'active'
      AND COALESCE(profiles.activation_status, 'active') = 'active'
      AND profiles.${column} = ?
    LIMIT 1`).get(value) || null : null;
  const byEmail = findActiveMember("normalized_email", normalizedEmail);
  const byPhone = findActiveMember("normalized_phone", normalizedPhone);
  if (byEmail && byPhone && byEmail.id !== byPhone.id) {
    throw new Error("Buyer email and phone belong to different active members.");
  }
  return byEmail || byPhone;
}

function activeReferrer(db, memberId) {
  if (!memberId) return null;
  return db.prepare(`SELECT referrer.id, referrer.member_code, referrer.name
    FROM member_referrals referrals
    JOIN members referrer ON referrer.id = referrals.referrer_member_id
    JOIN users ON users.id = referrer.user_id
    LEFT JOIN member_profiles profiles ON profiles.member_id = referrer.id
    WHERE referrals.member_id = ? AND referrals.status = 'active'
      AND users.status = 'active'
      AND COALESCE(profiles.activation_status, 'active') = 'active'
    LIMIT 1`).get(memberId) || null;
}

function activeProductBeneficiaries(db, productId) {
  const rows = db.prepare(`SELECT beneficiaries.role, members.id, members.member_code, members.name
    FROM product_revenue_beneficiaries beneficiaries
    JOIN members ON members.id = beneficiaries.beneficiary_member_id
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles profiles ON profiles.member_id = members.id
    WHERE beneficiaries.product_id = ?
      AND users.status = 'active'
      AND COALESCE(profiles.activation_status, 'active') = 'active'`).all(productId);
  return Object.fromEntries(rows.map((row) => [row.role, row]));
}

function createStageTestOrder(db, {
  productCode = "SOAP001",
  buyerName = "LT 綠界測試",
  buyerEmail = "payment-stage@lt.local",
  buyerPhone = "0900000000",
  buyerMemberCode = "",
  sharerCode = "",
  actorUserId = null,
  now = new Date()
} = {}) {
  const offer = db.prepare(`SELECT p.id AS product_id, p.product_code, p.name,
      config.checkout_mode, config.environment, config.stage_offer_code,
      offers.offer_code, offers.display_name, offers.paid_quantity, offers.bonus_quantity,
      offers.merchandise_amount, offers.shipping_amount, offers.currency,
      offers.distribution_json
    FROM products p
    JOIN product_checkout_configs config ON config.product_id = p.id
    JOIN product_checkout_offers offers
      ON offers.product_id = p.id AND offers.offer_code = config.stage_offer_code
    WHERE p.product_code = ? AND p.is_active = 1 AND offers.is_active = 1
    LIMIT 1`).get(String(productCode).trim().toUpperCase());
  if (!offer || offer.checkout_mode !== "stage_test" || offer.environment !== "stage") {
    throw new Error("Stage test product offer is not configured.");
  }
  const subtotalAmount = Number(offer.merchandise_amount);
  const shippingAmount = Number(offer.shipping_amount);
  const totalAmount = subtotalAmount + shippingAmount;
  if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
    throw new Error("Stage test product offer amount is invalid.");
  }
  const distribution = parseDistribution(offer.distribution_json);
  const sharer = sharerCode ? activeMemberByCode(db, sharerCode) : null;
  if (sharerCode && !sharer) throw new Error("Sharer member code is invalid or inactive.");
  const buyer = activeMemberByIdentity(db, {
    memberCode: buyerMemberCode,
    email: buyerEmail,
    phone: buyerPhone
  });
  if (buyerMemberCode && !buyer) throw new Error("Buyer member code is invalid or inactive.");
  const referrer = activeReferrer(db, buyer?.id);
  const productIntroducer = sharingFoundation.activeProductIntroducer(db, offer.product_id);
  const beneficiaries = activeProductBeneficiaries(db, offer.product_id);

  let orderNo = generateOrderNo(now);
  while (db.prepare("SELECT id FROM orders WHERE order_no = ?").get(orderNo)) orderNo = generateOrderNo(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const order = db.prepare(`INSERT INTO orders
      (order_no, environment, is_test, buyer_member_id, buyer_name, buyer_phone, buyer_email,
       sharer_member_id, referrer_member_id_snapshot,
       subtotal_amount, shipping_amount, total_amount, offer_code, checkout_source,
       order_status, payment_status, created_by_user_id)
      VALUES (?, 'stage', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin_stage',
        'pending', 'pending', ?)
      RETURNING *`).get(
        orderNo,
        buyer?.id || null,
        String(buyerName).trim().slice(0, 80),
        String(buyerPhone || "").trim().slice(0, 30),
        String(buyerEmail || "").trim().toLowerCase().slice(0, 254),
        sharer?.id || null,
        referrer?.id || null,
        subtotalAmount,
        shippingAmount,
        totalAmount,
        offer.offer_code,
        actorUserId
      );
    const item = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_code, product_name, quantity, unit_price, line_total,
       distribution_json, product_introducer_member_id_snapshot,
       supplier_member_id_snapshot, content_member_id_snapshot, platform_member_id_snapshot,
       offer_code, paid_quantity, bonus_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`).get(
        order.id,
        offer.product_id,
        offer.product_code,
        `${offer.name}｜${offer.display_name}`,
        offer.paid_quantity + offer.bonus_quantity,
        Math.floor(subtotalAmount / offer.paid_quantity),
        subtotalAmount,
        JSON.stringify(distribution),
        productIntroducer?.introducer_member_id || null,
        beneficiaries.supplier?.id || null,
        beneficiaries.content?.id || null,
        beneficiaries.platform?.id || null,
        offer.offer_code,
        offer.paid_quantity,
        offer.bonus_quantity
      );
    db.prepare(`INSERT INTO payment_events
      (order_id, provider, event_key, event_type, result_message, amount, payload_json)
      VALUES (?, 'internal', ?, 'order_created', 'Stage test order created; no payment received.', ?, '{}')`)
      .run(order.id, `order_created:${orderNo}`, totalAmount);
    db.exec("COMMIT");
    return { order, item, offer, distribution, buyer, sharer, referrer, productIntroducer, beneficiaries };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createProductionOrder(db, {
  productCode = "SOAP001",
  offerCode = "trial_1",
  buyerName,
  buyerEmail,
  buyerPhone,
  buyerMemberCode = "",
  receiverName,
  receiverPhone,
  shippingPostalCode = "",
  shippingAddress,
  sharerCode = "",
  checkoutSource = "lt-health.com.tw",
  checkoutToken,
  actorUserId = null,
  now = new Date()
} = {}) {
  const offer = db.prepare(`SELECT p.id AS product_id, p.product_code, p.name,
      offers.offer_code, offers.display_name, offers.paid_quantity, offers.bonus_quantity,
      offers.merchandise_amount, offers.shipping_amount, offers.currency,
      offers.distribution_json
    FROM products p
    JOIN product_checkout_offers offers ON offers.product_id = p.id
    WHERE p.product_code = ? AND offers.offer_code = ?
      AND p.is_active = 1 AND offers.is_active = 1
    LIMIT 1`).get(
      String(productCode).trim().toUpperCase(),
      String(offerCode).trim().toLowerCase()
    );
  if (!offer) throw new Error("Production checkout offer is not available.");

  const normalizedCheckoutToken = String(checkoutToken || "").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(normalizedCheckoutToken)) {
    throw new Error("Production checkout token is invalid.");
  }
  const checkoutTokenHash = crypto.createHash("sha256").update(normalizedCheckoutToken).digest("hex");
  const existingOrder = db.prepare("SELECT * FROM orders WHERE checkout_token_hash = ? LIMIT 1")
    .get(checkoutTokenHash);
  if (existingOrder) {
    const existingItem = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id LIMIT 1")
      .get(existingOrder.id);
    return { order: existingOrder, item: existingItem, reused: true };
  }

  const distribution = parseDistribution(offer.distribution_json);
  const subtotalAmount = Number(offer.merchandise_amount);
  const shippingAmount = Number(offer.shipping_amount);
  const totalAmount = subtotalAmount + shippingAmount;
  if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
    throw new Error("Production checkout amount is invalid.");
  }

  const buyer = activeMemberByIdentity(db, {
    memberCode: buyerMemberCode,
    email: buyerEmail,
    phone: buyerPhone
  });
  if (buyerMemberCode && !buyer) throw new Error("Buyer member code is invalid or inactive.");
  const sharer = sharerCode ? activeMemberByCode(db, sharerCode) : null;
  if (sharerCode && !sharer) throw new Error("Sharer member code is invalid or inactive.");
  const referrer = activeReferrer(db, buyer?.id);
  const productIntroducer = sharingFoundation.activeProductIntroducer(db, offer.product_id);
  const beneficiaries = activeProductBeneficiaries(db, offer.product_id);

  let orderNo = generateOrderNo(now);
  while (db.prepare("SELECT id FROM orders WHERE order_no = ?").get(orderNo)) orderNo = generateOrderNo(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const order = db.prepare(`INSERT INTO orders
      (order_no, environment, is_test, buyer_member_id, buyer_name, buyer_phone, buyer_email,
       sharer_member_id, referrer_member_id_snapshot,
       subtotal_amount, shipping_amount, total_amount, offer_code,
       receiver_name, receiver_phone, shipping_postal_code, shipping_address, checkout_source,
       checkout_token_hash, order_status, payment_status, created_by_user_id)
      VALUES (?, 'production', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'pending', 'pending', ?)
      RETURNING *`).get(
        orderNo,
        buyer?.id || null,
        String(buyerName || "").trim().slice(0, 80),
        String(buyerPhone || "").trim().slice(0, 30),
        String(buyerEmail || "").trim().toLowerCase().slice(0, 254),
        sharer?.id || null,
        referrer?.id || null,
        subtotalAmount,
        shippingAmount,
        totalAmount,
        offer.offer_code,
        String(receiverName || buyerName || "").trim().slice(0, 80),
        String(receiverPhone || buyerPhone || "").trim().slice(0, 30),
        String(shippingPostalCode || "").trim().slice(0, 10),
        String(shippingAddress || "").trim().slice(0, 300),
        String(checkoutSource || "").trim().slice(0, 120),
        checkoutTokenHash,
        actorUserId
      );
    const item = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_code, product_name, quantity, unit_price, line_total,
       distribution_json, product_introducer_member_id_snapshot,
       supplier_member_id_snapshot, content_member_id_snapshot, platform_member_id_snapshot,
       offer_code, paid_quantity, bonus_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`).get(
        order.id,
        offer.product_id,
        offer.product_code,
        `${offer.name}｜${offer.display_name}`,
        offer.paid_quantity + offer.bonus_quantity,
        Math.floor(subtotalAmount / offer.paid_quantity),
        subtotalAmount,
        JSON.stringify(distribution),
        productIntroducer?.introducer_member_id || null,
        beneficiaries.supplier?.id || null,
        beneficiaries.content?.id || null,
        beneficiaries.platform?.id || null,
        offer.offer_code,
        offer.paid_quantity,
        offer.bonus_quantity
      );
    db.prepare(`INSERT INTO payment_events
      (order_id, provider, event_key, event_type, result_message, amount, payload_json)
      VALUES (?, 'internal', ?, 'order_created', 'Production order created; payment pending.', ?, '{}')`)
      .run(order.id, `order_created:${orderNo}`, totalAmount);
    db.exec("COMMIT");
    return { order, item, offer, distribution, buyer, sharer, referrer, productIntroducer, beneficiaries };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function callbackEventKey(payload) {
  const raw = [
    payload.MerchantTradeNo,
    payload.TradeNo,
    payload.RtnCode,
    payload.PaymentDate || payload.TradeDate || "",
    payload.SimulatePaid || "0"
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function safeCallbackPayload(payload) {
  const allowed = [
    "MerchantID", "MerchantTradeNo", "TradeNo", "TradeAmt", "RtnCode", "RtnMsg",
    "PaymentDate", "PaymentType", "TradeDate", "SimulatePaid", "CustomField1", "CustomField2"
  ];
  return Object.fromEntries(allowed.filter((key) => payload[key] !== undefined).map((key) => [key, String(payload[key]).slice(0, 300)]));
}

function createAllocations(db, order) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(order.id);
  for (const item of items) {
    const explicitRelationships = hasExplicitRelationshipRates(item.distribution_json);
    const distribution = parseDistribution(item.distribution_json);
    const rates = explicitRelationships ? distribution : (() => {
      const referralRate = order.referrer_member_id_snapshot ? 1 : 0;
      const introducerRate = item.product_introducer_member_id_snapshot ? 2 : 0;
      if (referralRate + introducerRate > distribution.bonus_pool) {
        throw new Error("Referral rewards exceed the configured bonus pool.");
      }
      return {
        supplier: distribution.supplier,
        content: distribution.content,
        sharer: distribution.sharer,
        platform: distribution.platform,
        member_referral: referralRate,
        product_introducer: introducerRate,
        bonus_pool: distribution.bonus_pool - referralRate - introducerRate
      };
    })();
    const fixedRoles = ALLOCATION_ROLES.filter((role) => role !== "bonus_pool");
    const amounts = Object.fromEntries(fixedRoles.map((role) => [
      role,
      Math.floor(item.line_total * rates[role] / 100)
    ]));
    amounts.bonus_pool = item.line_total - fixedRoles.reduce((sum, role) => sum + amounts[role], 0);

    for (const role of ALLOCATION_ROLES) {
      if (!explicitRelationships && (role === "member_referral" || role === "product_introducer") && rates[role] === 0) continue;
      const beneficiaryMemberId = {
        supplier: item.supplier_member_id_snapshot,
        content: item.content_member_id_snapshot,
        sharer: order.sharer_member_id,
        platform: item.platform_member_id_snapshot,
        member_referral: order.referrer_member_id_snapshot,
        product_introducer: item.product_introducer_member_id_snapshot
      }[role] || null;
      const memberAssignedRole = ["supplier", "content", "sharer", "member_referral", "product_introducer"]
        .includes(role);
      const status = memberAssignedRole && !beneficiaryMemberId ? "unassigned" : "pending";
      db.prepare(`INSERT INTO order_allocations
        (order_id, order_item_id, role, beneficiary_member_id, rate, amount, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_item_id, role) DO NOTHING`)
        .run(order.id, item.id, role, beneficiaryMemberId, rates[role], amounts[role], status);
    }
  }
}

function applyEcpayCallback(db, payload, config) {
  ecpay.assertCallbackAllowed(config);
  if (String(payload.MerchantID || "") !== config.merchantId) throw new Error("ECPay MerchantID does not match.");
  if (!ecpay.verifyCheckMacValue(payload, config)) throw new Error("ECPay CheckMacValue is invalid.");
  const orderNo = String(payload.MerchantTradeNo || "");
  const order = db.prepare("SELECT * FROM orders WHERE order_no = ? LIMIT 1").get(orderNo);
  const expectedTestFlag = config.mode === "stage" ? 1 : 0;
  if (!order || order.environment !== config.mode || order.is_test !== expectedTestFlag) {
    throw new Error("ECPay order does not match the active payment environment.");
  }
  const amount = Number(payload.TradeAmt);
  if (!Number.isInteger(amount) || amount !== order.total_amount) throw new Error("ECPay payment amount does not match the order.");
  const resultCode = String(payload.RtnCode || "");
  const paid = resultCode === "1";
  const simulated = String(payload.SimulatePaid || "0") === "1";
  if (config.mode === "production" && simulated) {
    throw new Error("Simulated ECPay payment cannot settle a production order.");
  }
  const eventKey = callbackEventKey(payload);

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id FROM payment_events WHERE provider = 'ecpay' AND event_key = ?").get(eventKey);
    if (existing) {
      db.exec("COMMIT");
      return { order: db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id), duplicate: true, paid };
    }
    db.prepare(`INSERT INTO payment_events
      (order_id, provider, event_key, event_type, result_code, result_message, external_trade_no,
       amount, is_simulated, payload_json)
      VALUES (?, 'ecpay', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        order.id,
        eventKey,
        paid ? "payment_succeeded" : "payment_failed",
        resultCode,
        String(payload.RtnMsg || "").slice(0, 300),
        String(payload.TradeNo || "").slice(0, 40),
        amount,
        simulated ? 1 : 0,
        JSON.stringify(safeCallbackPayload(payload))
      );
    if (paid && order.payment_status !== "paid") {
      db.prepare(`UPDATE orders
        SET order_status = 'completed', payment_status = 'paid', payment_method = ?,
            gateway_trade_no = ?, gateway_result_code = ?, gateway_result_message = ?,
            paid_at = COALESCE(?, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`)
        .run(
          String(payload.PaymentType || "").slice(0, 60),
          String(payload.TradeNo || "").slice(0, 40),
          resultCode,
          String(payload.RtnMsg || "").slice(0, 300),
          String(payload.PaymentDate || "").trim() || null,
          order.id
        );
      createAllocations(db, { ...order, sharer_member_id: order.sharer_member_id });
    } else if (!paid && order.payment_status === "pending") {
      db.prepare(`UPDATE orders
        SET order_status = 'failed', payment_status = 'failed', gateway_result_code = ?,
            gateway_result_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(resultCode, String(payload.RtnMsg || "").slice(0, 300), order.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { order: db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id), duplicate: false, paid };
}

function orderWithDetails(db, orderNo) {
  const order = db.prepare(`SELECT orders.*, members.member_code AS sharer_code, members.name AS sharer_name
    FROM orders
    LEFT JOIN members ON members.id = orders.sharer_member_id
    WHERE orders.order_no = ? LIMIT 1`).get(String(orderNo || "")) || null;
  if (!order) return null;
  return {
    order,
    items: db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(order.id),
    allocations: db.prepare("SELECT * FROM order_allocations WHERE order_id = ? ORDER BY id").all(order.id),
    events: db.prepare("SELECT * FROM payment_events WHERE order_id = ? ORDER BY id").all(order.id)
  };
}

module.exports = {
  DISTRIBUTION_ROLES,
  ALLOCATION_ROLES,
  parseDistribution,
  generateOrderNo,
  activeMemberByCode,
  activeMemberByIdentity,
  activeReferrer,
  createStageTestOrder,
  createProductionOrder,
  applyEcpayCallback,
  orderWithDetails
};
