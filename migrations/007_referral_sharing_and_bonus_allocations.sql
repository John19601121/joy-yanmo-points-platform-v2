CREATE TABLE product_partner_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  referrer_member_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'cancelled')),
  change_reason TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (referrer_member_id) REFERENCES members(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_product_partner_referrals_one_active
  ON product_partner_referrals(product_id) WHERE status = 'active';

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  registration_url TEXT,
  starts_at TEXT,
  ends_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE share_attributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribution_token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'product', 'event')),
  referrer_member_id INTEGER NOT NULL,
  product_id INTEGER,
  event_id INTEGER,
  visitor_key_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'expired', 'cancelled')),
  clicked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  converted_member_id INTEGER,
  converted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (referrer_member_id) REFERENCES members(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (converted_member_id) REFERENCES members(id),
  CHECK (
    (kind = 'product' AND product_id IS NOT NULL AND event_id IS NULL)
    OR (kind = 'event' AND event_id IS NOT NULL AND product_id IS NULL)
    OR (kind = 'registration' AND product_id IS NULL AND event_id IS NULL)
  )
);

CREATE INDEX idx_share_attributions_active
  ON share_attributions(attribution_token, status, expires_at);
CREATE INDEX idx_share_attributions_referrer
  ON share_attributions(referrer_member_id, kind, clicked_at);

CREATE TABLE event_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  participant_member_id INTEGER,
  participant_name TEXT NOT NULL,
  normalized_email TEXT,
  normalized_phone TEXT,
  share_attribution_id INTEGER,
  temporary_referrer_member_id INTEGER,
  attribution_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (participant_member_id) REFERENCES members(id),
  FOREIGN KEY (share_attribution_id) REFERENCES share_attributions(id),
  FOREIGN KEY (temporary_referrer_member_id) REFERENCES members(id),
  CHECK (
    (temporary_referrer_member_id IS NULL AND attribution_expires_at IS NULL)
    OR (temporary_referrer_member_id IS NOT NULL AND attribution_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_event_registrations_email
  ON event_registrations(event_id, normalized_email) WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX idx_event_registrations_phone
  ON event_registrations(event_id, normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE INDEX idx_event_registrations_temporary_referrer
  ON event_registrations(participant_member_id, temporary_referrer_member_id, attribution_expires_at);

ALTER TABLE orders ADD COLUMN buyer_referrer_member_id INTEGER REFERENCES members(id);
ALTER TABLE orders ADD COLUMN share_attribution_id INTEGER REFERENCES share_attributions(id);
ALTER TABLE order_items ADD COLUMN partner_referrer_member_id INTEGER REFERENCES members(id);

ALTER TABLE order_allocations RENAME TO order_allocations_legacy;

CREATE TABLE order_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'supplier',
    'content',
    'sharer',
    'platform',
    'member_referrer',
    'product_partner_referrer',
    'bonus_pool'
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

INSERT INTO order_allocations
  (id, order_id, order_item_id, role, beneficiary_member_id, rate, amount, status, created_at, updated_at)
SELECT
  id, order_id, order_item_id, role, beneficiary_member_id, rate, amount, status, created_at, updated_at
FROM order_allocations_legacy;

DROP TABLE order_allocations_legacy;

CREATE INDEX idx_order_allocations_beneficiary
  ON order_allocations(beneficiary_member_id, status);
CREATE INDEX idx_orders_buyer_referrer
  ON orders(buyer_referrer_member_id, created_at);
CREATE INDEX idx_order_items_partner_referrer
  ON order_items(partner_referrer_member_id, created_at);
