const orderFoundation = require("./order-foundation");

const BENEFICIARY_ROLES = ["supplier", "content", "platform"];

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必須是 ${min} 到 ${max} 的整數。`);
  }
  return parsed;
}

function normalizeDistribution(input) {
  const distribution = Object.fromEntries(orderFoundation.DISTRIBUTION_ROLES.map((role) => [
    role,
    integer(input?.[role], `${role} 分潤`, { min: 0, max: 100 })
  ]));
  if (Object.values(distribution).reduce((sum, rate) => sum + rate, 0) !== 100) {
    throw new Error("七項分潤比例合計必須為 100%。");
  }
  return distribution;
}

function productById(db, productId) {
  const product = db.prepare("SELECT id, product_code, name FROM products WHERE id = ?").get(Number(productId));
  if (!product) throw new Error("找不到商品。");
  return product;
}

function activeMemberByCode(db, code, label) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  const member = orderFoundation.activeMemberByCode(db, normalized);
  if (!member) throw new Error(`${label}會員編號無效或尚未啟用。`);
  return member;
}

function saveOffer(db, {
  productId,
  offerCode,
  displayName,
  paidQuantity,
  bonusQuantity,
  merchandiseAmount,
  shippingAmount,
  distribution,
  isActive = true
}) {
  const product = productById(db, productId);
  const code = String(offerCode || "").trim().toLowerCase();
  const name = String(displayName || "").trim();
  if (!/^[a-z0-9_-]{2,40}$/.test(code)) throw new Error("方案編號只能使用小寫英文、數字、底線或連字號。");
  if (!name || name.length > 80) throw new Error("方案名稱必須為 1 到 80 個字元。");
  const paid = integer(paidQuantity, "付費數量", { min: 1, max: 100000 });
  const bonus = integer(bonusQuantity, "贈送數量", { min: 0, max: 100000 });
  const merchandise = integer(merchandiseAmount, "商品成交價", { min: 1, max: 100000000 });
  const shipping = integer(shippingAmount, "運費", { min: 0, max: 100000000 });
  const normalizedDistribution = normalizeDistribution(distribution);

  db.prepare(`INSERT INTO product_checkout_offers
      (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
       merchandise_amount, shipping_amount, currency, distribution_json, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'TWD', ?, ?)
    ON CONFLICT(product_id, offer_code) DO UPDATE SET
      display_name = excluded.display_name,
      paid_quantity = excluded.paid_quantity,
      bonus_quantity = excluded.bonus_quantity,
      merchandise_amount = excluded.merchandise_amount,
      shipping_amount = excluded.shipping_amount,
      currency = excluded.currency,
      distribution_json = excluded.distribution_json,
      is_active = excluded.is_active,
      updated_at = CURRENT_TIMESTAMP`).run(
    product.id,
    code,
    name,
    paid,
    bonus,
    merchandise,
    shipping,
    JSON.stringify(normalizedDistribution),
    isActive ? 1 : 0
  );
  return db.prepare("SELECT * FROM product_checkout_offers WHERE product_id = ? AND offer_code = ?")
    .get(product.id, code);
}

function savePeople(db, {
  productId,
  supplierCode = "",
  contentCode = "",
  platformCode = "",
  productIntroducerCode = "",
  actorUserId = null
}) {
  const product = productById(db, productId);
  const people = {
    supplier: activeMemberByCode(db, supplierCode, "供應商"),
    content: activeMemberByCode(db, contentCode, "內容製作／品牌包裝"),
    platform: activeMemberByCode(db, platformCode, "平台營運"),
    product_introducer: activeMemberByCode(db, productIntroducerCode, "商品／合作引薦人")
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const role of BENEFICIARY_ROLES) {
      const member = people[role];
      if (member) {
        db.prepare(`INSERT INTO product_revenue_beneficiaries
            (product_id, role, beneficiary_member_id, created_by_user_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(product_id, role) DO UPDATE SET
            beneficiary_member_id = excluded.beneficiary_member_id,
            created_by_user_id = excluded.created_by_user_id,
            updated_at = CURRENT_TIMESTAMP`).run(product.id, role, member.id, actorUserId);
      } else {
        db.prepare("DELETE FROM product_revenue_beneficiaries WHERE product_id = ? AND role = ?")
          .run(product.id, role);
      }
    }

    const currentIntroducer = db.prepare(`SELECT id, introducer_member_id
      FROM product_referrals WHERE product_id = ? AND status = 'active' LIMIT 1`).get(product.id);
    const nextIntroducerId = people.product_introducer?.id || null;
    if (currentIntroducer?.introducer_member_id !== nextIntroducerId) {
      if (currentIntroducer) {
        db.prepare(`UPDATE product_referrals
          SET status = ?, ended_at = CURRENT_TIMESTAMP, change_reason = ? WHERE id = ?`)
          .run(nextIntroducerId ? "replaced" : "cancelled", "商品後台設定更新", currentIntroducer.id);
      }
      if (nextIntroducerId) {
        db.prepare(`INSERT INTO product_referrals
          (product_id, introducer_member_id, change_reason, created_by_user_id)
          VALUES (?, ?, '商品後台設定更新', ?)`).run(product.id, nextIntroducerId, actorUserId);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { product, people };
}

function saveStageSelection(db, { productId, offerCode, enabled = false }) {
  const product = productById(db, productId);
  const code = String(offerCode || "").trim().toLowerCase();
  const offer = db.prepare(`SELECT * FROM product_checkout_offers
    WHERE product_id = ? AND offer_code = ? AND is_active = 1`).get(product.id, code);
  if (!offer) throw new Error("Stage 必須選擇已啟用的商品方案。");
  db.prepare(`INSERT INTO product_checkout_configs
      (product_id, environment, checkout_mode, stage_price, stage_offer_code, distribution_json)
    VALUES (?, 'stage', ?, NULL, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      environment = 'stage',
      checkout_mode = excluded.checkout_mode,
      stage_price = NULL,
      stage_offer_code = excluded.stage_offer_code,
      distribution_json = excluded.distribution_json,
      updated_at = CURRENT_TIMESTAMP`).run(
    product.id,
    enabled ? "stage_test" : "disabled",
    offer.offer_code,
    offer.distribution_json
  );
  return db.prepare("SELECT * FROM product_checkout_configs WHERE product_id = ?").get(product.id);
}

module.exports = {
  BENEFICIARY_ROLES,
  normalizeDistribution,
  saveOffer,
  savePeople,
  saveStageSelection
};
