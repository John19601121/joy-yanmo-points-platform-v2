const crypto = require("node:crypto");
const memberFoundation = require("./member-foundation");

const ATTRIBUTION_DAYS = 30;
const MEMBER_REFERRER_RATE = 1;
const PRODUCT_PARTNER_REFERRER_RATE = 2;

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
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

function activeReferralForMember(db, memberId) {
  if (!memberId) return null;
  return db.prepare(`SELECT referral.*, members.member_code, members.name
    FROM member_referrals referral
    JOIN members ON members.id = referral.referrer_member_id
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles ON member_profiles.member_id = members.id
    WHERE referral.member_id = ?
      AND referral.status = 'active'
      AND users.status = 'active'
      AND COALESCE(member_profiles.activation_status, 'active') = 'active'
    LIMIT 1`).get(memberId) || null;
}

function activeProductPartnerReferral(db, productId) {
  if (!productId) return null;
  return db.prepare(`SELECT referral.*, members.member_code, members.name
    FROM product_partner_referrals referral
    JOIN members ON members.id = referral.referrer_member_id
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles ON member_profiles.member_id = members.id
    WHERE referral.product_id = ?
      AND referral.status = 'active'
      AND users.status = 'active'
      AND COALESCE(member_profiles.activation_status, 'active') = 'active'
    LIMIT 1`).get(productId) || null;
}

function setProductPartnerReferral(db, {
  productId,
  referrerMemberId,
  source = "admin",
  actorUserId = null,
  reason = null
}) {
  if (!db.prepare("SELECT id FROM products WHERE id = ?").get(productId)) throw new Error("Product does not exist.");
  if (!db.prepare("SELECT id FROM members WHERE id = ?").get(referrerMemberId)) throw new Error("Partner referrer does not exist.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE product_partner_referrals
      SET status = 'replaced', ended_at = CURRENT_TIMESTAMP
      WHERE product_id = ? AND status = 'active'`).run(productId);
    db.prepare(`INSERT INTO product_partner_referrals
      (product_id, referrer_member_id, source, change_reason, created_by_user_id)
      VALUES (?, ?, ?, ?, ?)`).run(productId, referrerMemberId, source, reason, actorUserId);
    db.prepare(`INSERT INTO audit_events
      (event_type, actor_user_id, subject_type, subject_id, metadata_json)
      VALUES ('product_partner_referral_changed', ?, 'product', ?, ?)`)
      .run(actorUserId, productId, JSON.stringify({ referrer_member_id: referrerMemberId, source, reason }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function clearProductPartnerReferral(db, {
  productId,
  actorUserId = null,
  reason = "管理員清除商品引薦關係"
}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`UPDATE product_partner_referrals
      SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP, change_reason = COALESCE(?, change_reason)
      WHERE product_id = ? AND status = 'active'`).run(reason, productId);
    if (changed.changes) {
      db.prepare(`INSERT INTO audit_events
        (event_type, actor_user_id, subject_type, subject_id, metadata_json)
        VALUES ('product_partner_referral_cleared', ?, 'product', ?, ?)`)
        .run(actorUserId, productId, JSON.stringify({ reason }));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createShareAttribution(db, {
  kind,
  referrerCode,
  productCode = null,
  eventCode = null,
  visitorKey = null,
  now = new Date(),
  metadata = {}
}) {
  if (!["registration", "product", "event"].includes(kind)) throw new Error("Share attribution kind is invalid.");
  const referrer = activeMemberByCode(db, referrerCode);
  if (!referrer) throw new Error("Share referrer is invalid or inactive.");
  const product = kind === "product"
    ? db.prepare("SELECT id, product_code, name, product_page_url FROM products WHERE product_code = ? AND is_active = 1")
      .get(String(productCode || "").trim().toUpperCase())
    : null;
  if (kind === "product" && !product) throw new Error("Shared product is invalid or inactive.");
  const event = kind === "event"
    ? db.prepare("SELECT * FROM events WHERE event_code = ? AND is_active = 1")
      .get(String(eventCode || "").trim().toUpperCase())
    : null;
  if (kind === "event" && !event) throw new Error("Shared event is invalid or inactive.");
  const clickedAt = iso(now);
  const token = crypto.randomBytes(24).toString("base64url");
  const visitorKeyHash = visitorKey
    ? crypto.createHash("sha256").update(String(visitorKey)).digest("hex")
    : null;
  const attribution = db.prepare(`INSERT INTO share_attributions
    (attribution_token, kind, referrer_member_id, product_id, event_id, visitor_key_hash,
     clicked_at, expires_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *`).get(
      token,
      kind,
      referrer.id,
      product?.id || null,
      event?.id || null,
      visitorKeyHash,
      clickedAt,
      addDays(clickedAt, ATTRIBUTION_DAYS),
      JSON.stringify(metadata || {})
    );
  return { attribution, referrer, product, event };
}

function activeAttributionByToken(db, token, now = new Date()) {
  const normalized = String(token || "").trim();
  if (!normalized) return null;
  return db.prepare(`SELECT attribution.*, members.member_code AS referrer_code,
      members.name AS referrer_name
    FROM share_attributions attribution
    JOIN members ON members.id = attribution.referrer_member_id
    WHERE attribution.attribution_token = ?
      AND attribution.status IN ('active', 'converted')
      AND attribution.expires_at > ?
    LIMIT 1`).get(normalized, iso(now)) || null;
}

function memberByIdentity(db, { email = null, phone = null } = {}) {
  const normalizedEmail = memberFoundation.normalizeEmail(email);
  const normalizedPhone = memberFoundation.normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone) return null;
  return db.prepare(`SELECT members.id, members.member_code, members.name
    FROM members
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles profile ON profile.member_id = members.id
    WHERE users.status = 'active'
      AND COALESCE(profile.activation_status, 'active') = 'active'
      AND (
        (? IS NOT NULL AND COALESCE(profile.normalized_email, lower(trim(members.email))) = ?)
        OR (? IS NOT NULL AND COALESCE(profile.normalized_phone, members.phone) = ?)
      )
    ORDER BY members.id
    LIMIT 1`).get(normalizedEmail, normalizedEmail, normalizedPhone, normalizedPhone) || null;
}

function registerEventParticipant(db, {
  eventCode,
  name,
  email = null,
  phone = null,
  attributionToken = null,
  now = new Date()
}) {
  const event = db.prepare("SELECT * FROM events WHERE event_code = ? AND is_active = 1")
    .get(String(eventCode || "").trim().toUpperCase());
  if (!event) throw new Error("Event is invalid or inactive.");
  const participantName = String(name || "").trim();
  const normalizedEmail = memberFoundation.normalizeEmail(email);
  const normalizedPhone = memberFoundation.normalizePhone(phone);
  if (!participantName || (!normalizedEmail && !normalizedPhone)) throw new Error("Event participant identity is incomplete.");
  const member = memberByIdentity(db, { email: normalizedEmail, phone: normalizedPhone });
  const attribution = activeAttributionByToken(db, attributionToken, now);
  const validAttribution = attribution?.kind === "event" && attribution.event_id === event.id ? attribution : null;
  const expiresAt = validAttribution ? addDays(iso(now), ATTRIBUTION_DAYS) : null;

  db.exec("BEGIN IMMEDIATE");
  try {
    let existing = null;
    if (normalizedEmail) {
      existing = db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND normalized_email = ?")
        .get(event.id, normalizedEmail);
    }
    if (!existing && normalizedPhone) {
      existing = db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND normalized_phone = ?")
        .get(event.id, normalizedPhone);
    }
    let registration;
    if (existing) {
      registration = db.prepare(`UPDATE event_registrations
        SET participant_member_id = COALESCE(?, participant_member_id),
            participant_name = ?, normalized_email = COALESCE(?, normalized_email),
            normalized_phone = COALESCE(?, normalized_phone),
            share_attribution_id = COALESCE(?, share_attribution_id),
            temporary_referrer_member_id = COALESCE(?, temporary_referrer_member_id),
            attribution_expires_at = COALESCE(?, attribution_expires_at),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        RETURNING *`).get(
          member?.id || null,
          participantName,
          normalizedEmail,
          normalizedPhone,
          validAttribution?.id || null,
          validAttribution?.referrer_member_id || null,
          expiresAt,
          existing.id
        );
    } else {
      registration = db.prepare(`INSERT INTO event_registrations
        (event_id, participant_member_id, participant_name, normalized_email, normalized_phone,
         share_attribution_id, temporary_referrer_member_id, attribution_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`).get(
          event.id,
          member?.id || null,
          participantName,
          normalizedEmail,
          normalizedPhone,
          validAttribution?.id || null,
          validAttribution?.referrer_member_id || null,
          expiresAt
        );
    }
    if (validAttribution) {
      db.prepare(`UPDATE share_attributions
        SET status = 'converted', converted_member_id = COALESCE(?, converted_member_id),
            converted_at = COALESCE(converted_at, CURRENT_TIMESTAMP)
        WHERE id = ?`).run(member?.id || null, validAttribution.id);
    }
    db.prepare(`INSERT INTO audit_events
      (event_type, subject_type, subject_id, metadata_json)
      VALUES ('event_registered', 'event_registration', ?, ?)`)
      .run(registration.id, JSON.stringify({
        event_id: event.id,
        participant_member_id: member?.id || null,
        temporary_referrer_member_id: validAttribution?.referrer_member_id || null,
        attribution_expires_at: expiresAt
      }));
    db.exec("COMMIT");
    return { registration, event, member, attribution: validAttribution };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function activeEventReferrerForBuyer(db, {
  buyerMemberId = null,
  buyerEmail = null,
  buyerPhone = null,
  now = new Date()
} = {}) {
  const normalizedEmail = memberFoundation.normalizeEmail(buyerEmail);
  const normalizedPhone = memberFoundation.normalizePhone(buyerPhone);
  return db.prepare(`SELECT registration.*, members.member_code AS referrer_code,
      members.name AS referrer_name
    FROM event_registrations registration
    JOIN members ON members.id = registration.temporary_referrer_member_id
    WHERE registration.temporary_referrer_member_id IS NOT NULL
      AND registration.attribution_expires_at > ?
      AND (
        (? IS NOT NULL AND registration.participant_member_id = ?)
        OR (? IS NOT NULL AND registration.normalized_email = ?)
        OR (? IS NOT NULL AND registration.normalized_phone = ?)
      )
    ORDER BY registration.updated_at DESC, registration.id DESC
    LIMIT 1`).get(
      iso(now),
      buyerMemberId, buyerMemberId,
      normalizedEmail, normalizedEmail,
      normalizedPhone, normalizedPhone
    ) || null;
}

function resolveOrderAttribution(db, {
  productId,
  explicitSharerCode = null,
  attributionToken = null,
  buyerMemberId = null,
  buyerEmail = null,
  buyerPhone = null,
  now = new Date()
}) {
  const buyerReferrer = activeReferralForMember(db, buyerMemberId);
  const partnerReferrer = activeProductPartnerReferral(db, productId);
  const explicitSharer = explicitSharerCode ? activeMemberByCode(db, explicitSharerCode) : null;
  if (explicitSharerCode && !explicitSharer) throw new Error("Sharer member code is invalid or inactive.");
  const attribution = activeAttributionByToken(db, attributionToken, now);
  if (attribution?.kind === "product" && attribution.product_id !== productId) {
    throw new Error("Share attribution does not belong to this product.");
  }
  const completedEventAttribution = attribution?.kind === "event"
    ? db.prepare(`SELECT id FROM event_registrations
        WHERE share_attribution_id = ? AND attribution_expires_at > ?
        LIMIT 1`).get(attribution.id, iso(now))
    : null;
  const tokenSharer = attribution && (
    attribution.kind === "product"
    || (attribution.kind === "event" && completedEventAttribution)
  )
    ? {
        id: attribution.referrer_member_id,
        member_code: attribution.referrer_code,
        name: attribution.referrer_name
      }
    : null;
  const eventReferrer = activeEventReferrerForBuyer(db, {
    buyerMemberId,
    buyerEmail,
    buyerPhone,
    now
  });
  const sharer = explicitSharer || tokenSharer || (eventReferrer ? {
    id: eventReferrer.temporary_referrer_member_id,
    member_code: eventReferrer.referrer_code,
    name: eventReferrer.referrer_name
  } : null);
  return {
    sharer,
    buyerReferrer,
    partnerReferrer,
    shareAttribution: attribution,
    sharerSource: explicitSharer
      ? "explicit_product_link"
      : tokenSharer
        ? `${attribution.kind}_share_attribution`
        : eventReferrer
          ? "active_event_attribution"
          : null
  };
}

module.exports = {
  ATTRIBUTION_DAYS,
  MEMBER_REFERRER_RATE,
  PRODUCT_PARTNER_REFERRER_RATE,
  activeMemberByCode,
  activeReferralForMember,
  activeProductPartnerReferral,
  setProductPartnerReferral,
  clearProductPartnerReferral,
  createShareAttribution,
  activeAttributionByToken,
  memberByIdentity,
  registerEventParticipant,
  activeEventReferrerForBuyer,
  resolveOrderAttribution
};
