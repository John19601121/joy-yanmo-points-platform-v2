const crypto = require("node:crypto");

function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("886") && digits.length === 12) return `0${digits.slice(3)}`;
  return digits;
}

function sqliteTimestamp(value) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

function activeMemberById(db, memberId) {
  return db.prepare(`SELECT members.id, members.member_code, members.name
    FROM members
    JOIN users ON users.id = members.user_id
    LEFT JOIN member_profiles ON member_profiles.member_id = members.id
    WHERE members.id = ?
      AND users.status = 'active'
      AND COALESCE(member_profiles.activation_status, 'active') = 'active'
    LIMIT 1`).get(memberId) || null;
}

function createEvent(db, { eventCode, title, startsAt = null, actorUserId = null }) {
  const code = String(eventCode || "").trim().toUpperCase();
  const eventTitle = String(title || "").trim();
  if (!code || !eventTitle) throw new Error("Event code and title are required.");
  return db.prepare(`INSERT INTO platform_events
    (event_code, title, starts_at, created_by_user_id)
    VALUES (?, ?, ?, ?) RETURNING *`).get(code, eventTitle, startsAt || null, actorUserId);
}

function createShareLink(db, {
  sharerMemberId,
  linkType,
  productId = null,
  eventId = null,
  token = null
}) {
  if (!activeMemberById(db, sharerMemberId)) throw new Error("Sharer member is invalid or inactive.");
  if (!["member", "product", "event"].includes(linkType)) throw new Error("Share link type is invalid.");
  if (linkType === "product" && !db.prepare("SELECT id FROM products WHERE id = ? AND is_active = 1").get(productId)) {
    throw new Error("Product is invalid or inactive.");
  }
  if (linkType === "event" && !db.prepare("SELECT id FROM platform_events WHERE id = ? AND registration_open = 1").get(eventId)) {
    throw new Error("Event is invalid or registration is closed.");
  }
  const shareToken = token || crypto.randomBytes(18).toString("base64url");
  return db.prepare(`INSERT INTO share_links
    (token, sharer_member_id, link_type, product_id, event_id)
    VALUES (?, ?, ?, ?, ?) RETURNING *`).get(
      shareToken,
      sharerMemberId,
      linkType,
      linkType === "product" ? productId : null,
      linkType === "event" ? eventId : null
    );
}

function shareLinkByToken(db, token) {
  return db.prepare(`SELECT links.*, members.member_code AS sharer_code,
      products.product_code, events.event_code, events.title AS event_title
    FROM share_links links
    JOIN members ON members.id = links.sharer_member_id
    LEFT JOIN products ON products.id = links.product_id
    LEFT JOIN platform_events events ON events.id = links.event_id
    WHERE links.token = ? AND links.status = 'active'
    LIMIT 1`).get(String(token || "")) || null;
}

function recordShareClick(db, token, { ipHash = null, userAgent = null } = {}) {
  const link = shareLinkByToken(db, token);
  if (!link) throw new Error("Share link is invalid or disabled.");
  db.prepare(`INSERT INTO share_clicks (share_link_id, ip_hash, user_agent)
    VALUES (?, ?, ?)`).run(link.id, ipHash, String(userAgent || "").slice(0, 300) || null);
  return link;
}

function expireProtections(db, now = new Date()) {
  return db.prepare(`UPDATE prospect_protections
    SET status = 'expired'
    WHERE status = 'active' AND expires_at <= ?`).run(sqliteTimestamp(now)).changes;
}

function activeProtectionByIdentity(db, { email = null, phone = null, now = new Date() }) {
  expireProtections(db, now);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone) return null;
  return db.prepare(`SELECT protections.*, members.member_code AS protected_by_code
    FROM prospect_protections protections
    JOIN members ON members.id = protections.protected_by_member_id
    WHERE protections.status = 'active'
      AND protections.expires_at > ?
      AND (
        (? IS NOT NULL AND protections.normalized_email = ?)
        OR (? IS NOT NULL AND protections.normalized_phone = ?)
      )
    ORDER BY protections.id
    LIMIT 1`).get(
      sqliteTimestamp(now),
      normalizedEmail, normalizedEmail,
      normalizedPhone, normalizedPhone
    ) || null;
}

function registerForEvent(db, {
  eventId,
  shareToken = null,
  attendeeName,
  email = null,
  phone = null,
  now = new Date(),
  protectionDays = 30
}) {
  const event = db.prepare("SELECT * FROM platform_events WHERE id = ? AND registration_open = 1").get(eventId);
  if (!event) throw new Error("Event is invalid or registration is closed.");
  const name = String(attendeeName || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (!name || (!normalizedEmail && !normalizedPhone)) throw new Error("Attendee name and contact are required.");

  const link = shareToken ? shareLinkByToken(db, shareToken) : null;
  if (shareToken && (!link || link.link_type !== "event" || link.event_id !== event.id)) {
    throw new Error("Event share link is invalid.");
  }
  const existingMember = db.prepare(`SELECT members.id
    FROM members
    LEFT JOIN member_profiles profiles ON profiles.member_id = members.id
    WHERE (? IS NOT NULL AND profiles.normalized_email = ?)
       OR (? IS NOT NULL AND profiles.normalized_phone = ?)
    LIMIT 1`).get(normalizedEmail, normalizedEmail, normalizedPhone, normalizedPhone) || null;

  db.exec("BEGIN IMMEDIATE");
  try {
    expireProtections(db, now);
    const registration = db.prepare(`INSERT INTO event_registrations
      (event_id, share_link_id, invited_by_member_id, member_id, attendee_name, normalized_email, normalized_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
        event.id,
        link?.id || null,
        link?.sharer_member_id || null,
        existingMember?.id || null,
        name,
        normalizedEmail,
        normalizedPhone
      );

    let protection = null;
    let protectedByExisting = false;
    if (link && !existingMember) {
      const existing = activeProtectionByIdentity(db, { email: normalizedEmail, phone: normalizedPhone, now });
      if (existing) {
        protection = existing;
        protectedByExisting = true;
      } else {
        const expiresAt = new Date(now.getTime() + protectionDays * 24 * 60 * 60 * 1000);
        protection = db.prepare(`INSERT INTO prospect_protections
          (event_registration_id, protected_by_member_id, normalized_email, normalized_phone, starts_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?) RETURNING *`).get(
            registration.id,
            link.sharer_member_id,
            normalizedEmail,
            normalizedPhone,
            sqliteTimestamp(now),
            sqliteTimestamp(expiresAt)
          );
      }
    }
    db.exec("COMMIT");
    return { registration, protection, protectedByExisting, existingMember: Boolean(existingMember) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function consumeProtection(db, protectionId, memberId, now = new Date()) {
  return db.prepare(`UPDATE prospect_protections
    SET status = 'converted', converted_member_id = ?, converted_at = ?
    WHERE id = ? AND status = 'active'`).run(memberId, sqliteTimestamp(now), protectionId).changes === 1;
}

function setProductIntroducer(db, productId, introducerMemberId, {
  actorUserId = null,
  reason = null
} = {}) {
  if (!db.prepare("SELECT id FROM products WHERE id = ?").get(productId)) throw new Error("Product does not exist.");
  if (!activeMemberById(db, introducerMemberId)) throw new Error("Introducer member is invalid or inactive.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE product_referrals
      SET status = 'replaced', ended_at = CURRENT_TIMESTAMP
      WHERE product_id = ? AND status = 'active'`).run(productId);
    const referral = db.prepare(`INSERT INTO product_referrals
      (product_id, introducer_member_id, change_reason, created_by_user_id)
      VALUES (?, ?, ?, ?) RETURNING *`).get(productId, introducerMemberId, reason, actorUserId);
    db.exec("COMMIT");
    return referral;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function activeProductIntroducer(db, productId) {
  return db.prepare(`SELECT referrals.*, members.member_code, members.name
    FROM product_referrals referrals
    JOIN members ON members.id = referrals.introducer_member_id
    WHERE referrals.product_id = ? AND referrals.status = 'active'
    LIMIT 1`).get(productId) || null;
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  sqliteTimestamp,
  createEvent,
  createShareLink,
  shareLinkByToken,
  recordShareClick,
  expireProtections,
  activeProtectionByIdentity,
  registerForEvent,
  consumeProtection,
  setProductIntroducer,
  activeProductIntroducer
};
