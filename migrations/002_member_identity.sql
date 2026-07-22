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
