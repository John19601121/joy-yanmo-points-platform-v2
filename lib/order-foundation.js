const crypto = require("node:crypto");
const ecpay = require("./ecpay");
const referralSharing = require("./referral-sharing");

const DISTRIBUTION_ROLES = ["supplier", "content", "sharer", "platform", "bonus_pool"];
const ALLOCATION_ROLES = [
  "supplier",
  "content",
  "sharer",
  "platform",
  "member_referrer",
  "product_partner_referrer",
  "bonus_pool"
];

function parseDistribution(value) {
  let distribution;
  try {
    distribution = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Product distribution is invalid.");
  }
  if (!distribution || typeof distribution !== "object") throw new Error("Product distribution is invalid.");
  const normalized = Object.fromEntries(DISTRIBUTION_ROLES.map((role) => {
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
  return referralSharing.activeMemberByCode(db, memberCode);
}

function createStageTestOrder(db, {
  productCode = "SOAP001",
  buyerName = "LT 綠界測試",
  buyerEmail = "payment-stage@lt.local",
  buyerPhone = "0900000000",
  buyerMemberCode = "",
  sharerCode = "",
  attributionToken = "",
  actorUserId = null,
  now = new Date()
} = {}) {
  const product = db.prepare(`SELECT p.id, p.product_code, p.name, config.checkout_mode,
      config.environment, config.stage_price, config.distribution_json
    FROM products p
    JOIN product_checkout_configs config ON config.product_id = p.id
    WHERE p.product_code = ? AND p.is_active = 1
    LIMIT 1`).get(String(productCode).trim().toUpperCase());
  if (!product || product.checkout_mode !== "stage_test" || product.environment !== "stage") {
    throw new Error("Stage test product is not configured.");
  }
  if (!Number.isInteger(product.stage_price) || product.stage_price <= 0) {
    throw new Error("Stage test product price is invalid.");
  }
  const distribution = parseDistribution(product.distribution_json);
  const buyerMember = buyerMemberCode
    ? activeMemberByCode(db, buyerMemberCode)
    : referralSharing.memberByIdentity(db, { email: buyerEmail, phone: buyerPhone });
  if (buyerMemberCode && !buyerMember) throw new Error("Buyer member code is invalid or inactive.");
  const attribution = referralSharing.resolveOrderAttribution(db, {
    productId: product.id,
    explicitSharerCode: sharerCode,
    attributionToken,
    buyerMemberId: buyerMember?.id || null,
    buyerEmail,
    buyerPhone,
    now
  });

  let orderNo = generateOrderNo(now);
  while (db.prepare("SELECT id FROM orders WHERE order_no = ?").get(orderNo)) orderNo = generateOrderNo(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const order = db.prepare(`INSERT INTO orders
      (order_no, environment, is_test, buyer_member_id, buyer_name, buyer_phone, buyer_email,
       sharer_member_id, buyer_referrer_member_id, share_attribution_id,
       total_amount, order_status, payment_status, created_by_user_id)
      VALUES (?, 'stage', 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)
      RETURNING *`).get(
        orderNo,
        buyerMember?.id || null,
        String(buyerName).trim().slice(0, 80),
        String(buyerPhone || "").trim().slice(0, 30),
        String(buyerEmail || "").trim().toLowerCase().slice(0, 254),
        attribution.sharer?.id || null,
        attribution.buyerReferrer?.referrer_member_id || null,
        attribution.shareAttribution?.id || null,
        product.stage_price,
        actorUserId
      );
    const item = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_code, product_name, quantity, unit_price, line_total,
       distribution_json, partner_referrer_member_id)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      RETURNING *`).get(
        order.id,
        product.id,
        product.product_code,
        product.name,
        product.stage_price,
        product.stage_price,
        JSON.stringify(distribution),
        attribution.partnerReferrer?.referrer_member_id || null
      );
    db.prepare(`INSERT INTO payment_events
      (order_id, provider, event_key, event_type, result_message, amount, payload_json)
      VALUES (?, 'internal', ?, 'order_created', 'Stage test order created; no payment received.', ?, '{}')`)
      .run(order.id, `order_created:${orderNo}`, product.stage_price);
    db.exec("COMMIT");
    return {
      order,
      item,
      distribution,
      buyerMember,
      sharer: attribution.sharer,
      buyerReferrer: attribution.buyerReferrer,
      partnerReferrer: attribution.partnerReferrer,
      sharerSource: attribution.sharerSource
    };
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
  attributionToken = "",
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
  const buyerMember = buyerMemberCode
    ? activeMemberByCode(db, buyerMemberCode)
    : referralSharing.memberByIdentity(db, { email: buyerEmail, phone: buyerPhone });
  if (buyerMemberCode && !buyerMember) throw new Error("Buyer member code is invalid or inactive.");
  const attribution = referralSharing.resolveOrderAttribution(db, {
    productId: offer.product_id,
    explicitSharerCode: sharerCode,
    attributionToken,
    buyerMemberId: buyerMember?.id || null,
    buyerEmail,
    buyerPhone,
    now
  });

  let orderNo = generateOrderNo(now);
  while (db.prepare("SELECT id FROM orders WHERE order_no = ?").get(orderNo)) orderNo = generateOrderNo(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const order = db.prepare(`INSERT INTO orders
      (order_no, environment, is_test, buyer_member_id, buyer_name, buyer_phone, buyer_email,
       sharer_member_id, buyer_referrer_member_id, share_attribution_id,
       subtotal_amount, shipping_amount, total_amount, offer_code,
       receiver_name, receiver_phone, shipping_postal_code, shipping_address, checkout_source,
       checkout_token_hash,
       order_status, payment_status, created_by_user_id)
      VALUES (?, 'production', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'pending', 'pending', ?)
      RETURNING *`).get(
        orderNo,
        buyerMember?.id || null,
        String(buyerName || "").trim().slice(0, 80),
        String(buyerPhone || "").trim().slice(0, 30),
        String(buyerEmail || "").trim().toLowerCase().slice(0, 254),
        attribution.sharer?.id || null,
        attribution.buyerReferrer?.referrer_member_id || null,
        attribution.shareAttribution?.id || null,
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
       distribution_json, partner_referrer_member_id, offer_code, paid_quantity, bonus_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`).get(
        order.id,
        offer.product_id,
        offer.product_code,
        `${offer.name}｜${offer.display_name}`,
        offer.paid_quantity + offer.bonus_quantity,
        Math.floor(subtotalAmount / offer.paid_quantity),
        subtotalAmount,
        JSON.stringify(distribution),
        attribution.partnerReferrer?.referrer_member_id || null,
        offer.offer_code,
        offer.paid_quantity,
        offer.bonus_quantity
      );
    db.prepare(`INSERT INTO payment_events
      (order_id, provider, event_key, event_type, result_message, amount, payload_json)
      VALUES (?, 'internal', ?, 'order_created', 'Production order created; payment pending.', ?, '{}')`)
      .run(order.id, `order_created:${orderNo}`, totalAmount);
    db.exec("COMMIT");
    return {
      order,
      item,
      offer,
      distribution,
      buyerMember,
      sharer: attribution.sharer,
      buyerReferrer: attribution.buyerReferrer,
      partnerReferrer: attribution.partnerReferrer,
      sharerSource: attribution.sharerSource
    };
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

function exactAllocationAmounts(lineTotal, rates) {
  const entries = Object.entries(rates);
  const amounts = Object.fromEntries(entries.map(([role, rate]) => [role, Math.floor(lineTotal * rate / 100)]));
  const residual = lineTotal - Object.values(amounts).reduce((sum, amount) => sum + amount, 0);
  if (residual > 0) {
    const residualRole = Object.hasOwn(amounts, "bonus_pool") ? "bonus_pool" : "platform";
    amounts[residualRole] += residual;
  }
  return amounts;
}

function allocationPlan(distribution, order, item) {
  const memberReferrerRate = order.buyer_referrer_member_id ? referralSharing.MEMBER_REFERRER_RATE : 0;
  const partnerReferrerRate = item.partner_referrer_member_id ? referralSharing.PRODUCT_PARTNER_REFERRER_RATE : 0;
  const bonusPoolRate = distribution.bonus_pool - memberReferrerRate - partnerReferrerRate;
  if (bonusPoolRate < 0) throw new Error("Product bonus pool cannot fund referral rewards.");
  return {
    supplier: { rate: distribution.supplier, beneficiaryMemberId: null },
    content: { rate: distribution.content, beneficiaryMemberId: null },
    sharer: { rate: distribution.sharer, beneficiaryMemberId: order.sharer_member_id || null },
    platform: { rate: distribution.platform, beneficiaryMemberId: null },
    member_referrer: { rate: memberReferrerRate, beneficiaryMemberId: order.buyer_referrer_member_id || null },
    product_partner_referrer: { rate: partnerReferrerRate, beneficiaryMemberId: item.partner_referrer_member_id || null },
    bonus_pool: { rate: bonusPoolRate, beneficiaryMemberId: null }
  };
}

function createAllocations(db, order) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(order.id);
  for (const item of items) {
    const distribution = parseDistribution(item.distribution_json);
    const plan = allocationPlan(distribution, order, item);
    const amounts = exactAllocationAmounts(
      item.line_total,
      Object.fromEntries(ALLOCATION_ROLES.map((role) => [role, plan[role].rate]))
    );
    for (const role of ALLOCATION_ROLES) {
      const { rate, beneficiaryMemberId } = plan[role];
      const amount = amounts[role];
      const requiresBeneficiary = ["sharer", "member_referrer", "product_partner_referrer"].includes(role);
      const status = requiresBeneficiary && !beneficiaryMemberId ? "unassigned" : "pending";
      db.prepare(`INSERT INTO order_allocations
        (order_id, order_item_id, role, beneficiary_member_id, rate, amount, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_item_id, role) DO NOTHING`)
        .run(order.id, item.id, role, beneficiaryMemberId, rate, amount, status);
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
  const order = db.prepare(`SELECT orders.*, sharer.member_code AS sharer_code, sharer.name AS sharer_name,
      buyer_referrer.member_code AS buyer_referrer_code, buyer_referrer.name AS buyer_referrer_name
    FROM orders
    LEFT JOIN members sharer ON sharer.id = orders.sharer_member_id
    LEFT JOIN members buyer_referrer ON buyer_referrer.id = orders.buyer_referrer_member_id
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
  exactAllocationAmounts,
  allocationPlan,
  createStageTestOrder,
  createProductionOrder,
  applyEcpayCallback,
  orderWithDetails
};
