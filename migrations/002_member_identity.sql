CREATE TABLE member_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL UNIQUE,
  normalized_email TEXT,
  normalized_phone TEXT,
  line_id TEXT,
  is_hci_member INTEGER NOT NULL DEFAULT 0 CHECK (is_hci_member IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'legacy',
  activation_status TEXT NOT NULL DEFAULT 'active' CHECK (activation_status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

WITH RECURSIVE phone_digits(member_id, phone, position, digits) AS (
  SELECT id, coalesce(phone, ''), 1, '' FROM members
  UNION ALL
  SELECT member_id, phone, position + 1,
    digits || CASE WHEN substr(phone, position, 1) BETWEEN '0' AND '9' THEN substr(phone, position, 1) ELSE '' END
  FROM phone_digits
  WHERE position <= length(phone)
), normalized_phones AS (
  SELECT member_id,
    CASE WHEN substr(digits, 1, 3) = '886' AND length(digits) = 12 THEN '0' || substr(digits, 4) ELSE digits END AS phone
  FROM phone_digits
  WHERE position = length(phone) + 1
)
INSERT INTO member_profiles (member_id, normalized_email, normalized_phone, source, activation_status)
SELECT
  members.id,
  NULLIF(lower(trim(members.email)), ''),
  NULLIF(normalized_phones.phone, ''),
  'legacy',
  'active'
FROM members
JOIN normalized_phones ON normalized_phones.member_id = members.id;

CREATE UNIQUE INDEX idx_member_profiles_email ON member_profiles(normalized_email) WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX idx_member_profiles_phone ON member_profiles(normalized_phone) WHERE normalized_phone IS NOT NULL;

CREATE TABLE member_activation_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
