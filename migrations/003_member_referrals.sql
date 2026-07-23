CREATE TABLE member_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  referrer_member_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'cancelled')),
  change_reason TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (referrer_member_id) REFERENCES members(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CHECK (member_id <> referrer_member_id)
);

CREATE UNIQUE INDEX idx_member_referrals_one_active ON member_referrals(member_id) WHERE status = 'active';
