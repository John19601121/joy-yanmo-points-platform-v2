CREATE TABLE payout_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL UNIQUE,
  payout_method TEXT NOT NULL DEFAULT 'unset' CHECK (payout_method IN ('unset', 'bank_transfer', 'lt_token')),
  status TEXT NOT NULL DEFAULT 'incomplete' CHECK (status IN ('incomplete', 'pending_review', 'verified', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  subject_type TEXT NOT NULL,
  subject_id INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX idx_audit_events_subject ON audit_events(subject_type, subject_id, created_at);

CREATE TABLE feature_flags (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO feature_flags (name, enabled) VALUES ('member_self_registration', 0);
INSERT INTO feature_flags (name, enabled) VALUES ('member_import_activation', 0);
