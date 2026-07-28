CREATE TABLE platform_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  starts_at TEXT,
  registration_open INTEGER NOT NULL DEFAULT 1 CHECK (registration_open IN (0, 1)),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  sharer_member_id INTEGER NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('member', 'product', 'event')),
  product_id INTEGER,
  event_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sharer_member_id) REFERENCES members(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (event_id) REFERENCES platform_events(id),
  CHECK (
    (link_type = 'member' AND product_id IS NULL AND event_id IS NULL) OR
    (link_type = 'product' AND product_id IS NOT NULL AND event_id IS NULL) OR
    (link_type = 'event' AND product_id IS NULL AND event_id IS NOT NULL)
  )
);

CREATE TABLE share_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_link_id INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (share_link_id) REFERENCES share_links(id)
);

CREATE TABLE event_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  share_link_id INTEGER,
  invited_by_member_id INTEGER,
  member_id INTEGER,
  attendee_name TEXT NOT NULL,
  normalized_email TEXT,
  normalized_phone TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES platform_events(id),
  FOREIGN KEY (share_link_id) REFERENCES share_links(id),
  FOREIGN KEY (invited_by_member_id) REFERENCES members(id),
  FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE prospect_protections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_registration_id INTEGER NOT NULL UNIQUE,
  protected_by_member_id INTEGER NOT NULL,
  normalized_email TEXT,
  normalized_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'converted', 'expired', 'cancelled')),
  starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  converted_member_id INTEGER,
  converted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_registration_id) REFERENCES event_registrations(id),
  FOREIGN KEY (protected_by_member_id) REFERENCES members(id),
  FOREIGN KEY (converted_member_id) REFERENCES members(id),
  CHECK (normalized_email IS NOT NULL OR normalized_phone IS NOT NULL)
);

CREATE UNIQUE INDEX idx_prospect_protection_email_active
  ON prospect_protections(normalized_email)
  WHERE status = 'active' AND normalized_email IS NOT NULL;
CREATE UNIQUE INDEX idx_prospect_protection_phone_active
  ON prospect_protections(normalized_phone)
  WHERE status = 'active' AND normalized_phone IS NOT NULL;
CREATE INDEX idx_prospect_protection_expiry
  ON prospect_protections(status, expires_at);

CREATE TABLE product_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  introducer_member_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'cancelled')),
  change_reason TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (introducer_member_id) REFERENCES members(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_product_referrals_one_active
  ON product_referrals(product_id)
  WHERE status = 'active';

ALTER TABLE orders ADD COLUMN referrer_member_id_snapshot INTEGER REFERENCES members(id);
ALTER TABLE order_items ADD COLUMN product_introducer_member_id_snapshot INTEGER REFERENCES members(id);

CREATE TABLE order_allocations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'supplier', 'content', 'sharer', 'platform',
    'member_referral', 'product_introducer', 'bonus_pool'
  )),
  beneficiary_member_id INTEGER,
  rate INTEGER NOT NULL CHECK (rate >= 0 AND rate <= 100),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'payable', 'paid', 'converted_to_token', 'reversed', 'cancelled', 'unassigned')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  FOREIGN KEY (beneficiary_member_id) REFERENCES members(id),
  UNIQUE (order_item_id, role)
);

INSERT INTO order_allocations_new
  (id, order_id, order_item_id, role, beneficiary_member_id, rate, amount, status, created_at, updated_at)
SELECT id, order_id, order_item_id, role, beneficiary_member_id, rate, amount, status, created_at, updated_at
FROM order_allocations;

DROP TABLE order_allocations;
ALTER TABLE order_allocations_new RENAME TO order_allocations;

CREATE INDEX idx_order_allocations_beneficiary
  ON order_allocations(beneficiary_member_id, status);
CREATE INDEX idx_share_links_member
  ON share_links(sharer_member_id, link_type, status);
CREATE INDEX idx_event_registrations_event
  ON event_registrations(event_id, created_at);
