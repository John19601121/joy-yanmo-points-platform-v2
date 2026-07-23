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

function headquartersId(db) {
  const row = db.prepare("SELECT id FROM stores WHERE is_system_default = 1 AND status = 'active'").get();
  if (!row) throw new Error("System headquarters is not configured.");
  return row.id;
}

function featureEnabled(db, name) {
  const environmentNames = {
    member_self_registration: "FEATURE_MEMBER_SELF_REGISTRATION",
    member_import_activation: "FEATURE_MEMBER_IMPORT_ACTIVATION"
  };
  const environmentName = environmentNames[name];
  if (environmentName && process.env[environmentName] !== undefined) return process.env[environmentName] === "true";
  return db.prepare("SELECT enabled FROM feature_flags WHERE name = ?").get(name)?.enabled === 1;
}

function activateMember(db, token) {
  const tokenHash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = db.prepare(`SELECT token.id, token.member_id, token.expires_at, token.used_at, profile.activation_status
      FROM member_activation_tokens token
      JOIN member_profiles profile ON profile.member_id = token.member_id
      WHERE token.token_hash = ?`).get(tokenHash);
    if (!record || record.used_at || record.activation_status !== "pending" || Date.parse(record.expires_at) <= Date.now()) {
      throw new Error("Activation token is invalid or expired.");
    }
    db.prepare(`UPDATE member_activation_tokens SET used_at = CURRENT_TIMESTAMP
      WHERE member_id = ? AND used_at IS NULL`).run(record.member_id);
    const activated = db.prepare(`UPDATE member_profiles SET activation_status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE member_id = ? AND activation_status = 'pending'`).run(record.member_id);
    if (activated.changes !== 1) throw new Error("Member is not pending activation.");
    db.prepare(`INSERT INTO audit_events (event_type, subject_type, subject_id, metadata_json)
      VALUES ('member_activated', 'member', ?, '{}')`).run(record.member_id);
    db.exec("COMMIT");
    return record.member_id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createActivationToken(db, memberId, ttlMinutes = 60 * 24) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const profile = db.prepare("SELECT activation_status FROM member_profiles WHERE member_id = ?").get(memberId);
    if (!profile || profile.activation_status !== "pending") throw new Error("Member is not pending activation.");
    db.prepare("UPDATE member_activation_tokens SET used_at = CURRENT_TIMESTAMP WHERE member_id = ? AND used_at IS NULL").run(memberId);
    db.prepare("INSERT INTO member_activation_tokens (member_id, token_hash, expires_at) VALUES (?, ?, ?)")
      .run(memberId, tokenHash, expiresAt);
    db.exec("COMMIT");
    return token;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function setReferral(db, memberId, referrerMemberId, source, actorUserId = null, reason = null) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (memberId === referrerMemberId) throw new Error("A member cannot refer themselves.");
    if (!db.prepare("SELECT id FROM members WHERE id = ?").get(memberId) || !db.prepare("SELECT id FROM members WHERE id = ?").get(referrerMemberId)) {
      throw new Error("Member or referrer does not exist.");
    }
    let cursor = referrerMemberId;
    const seen = new Set([memberId]);
    while (cursor) {
      if (seen.has(cursor)) throw new Error("Referral cycle is not allowed.");
      seen.add(cursor);
      cursor = db.prepare("SELECT referrer_member_id FROM member_referrals WHERE member_id = ? AND status = 'active'").get(cursor)?.referrer_member_id;
    }
    db.prepare("UPDATE member_referrals SET status = 'replaced', ended_at = CURRENT_TIMESTAMP WHERE member_id = ? AND status = 'active'").run(memberId);
    db.prepare(`INSERT INTO member_referrals
      (member_id, referrer_member_id, source, change_reason, created_by_user_id)
      VALUES (?, ?, ?, ?, ?)`
    ).run(memberId, referrerMemberId, source, reason, actorUserId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { normalizeEmail, normalizePhone, headquartersId, featureEnabled, createActivationToken, activateMember, setReferral };
