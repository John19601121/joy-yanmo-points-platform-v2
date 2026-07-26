CREATE TABLE product_checkout_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE,
  environment TEXT NOT NULL DEFAULT 'stage' CHECK (environment IN ('stage', 'production')),
  checkout_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (checkout_mode IN ('disabled', 'stage_test', 'production')),
  stage_price INTEGER CHECK (stage_price IS NULL OR stage_price > 0),
  distribution_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('stage', 'production')),
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  buyer_member_id INTEGER,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT,
  buyer_email TEXT,
  sharer_member_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  total_amount INTEGER NOT NULL CHECK (total_amount > 0),
  order_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (order_status IN ('pending', 'processing', 'completed', 'cancelled', 'refunded', 'failed')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled', 'refund_pending', 'refunded')),
  payment_provider TEXT NOT NULL DEFAULT 'ecpay',
  payment_method TEXT,
  gateway_trade_no TEXT,
  gateway_result_code TEXT,
  gateway_result_message TEXT,
  paid_at TEXT,
  cancelled_at TEXT,
  refund_requested_at TEXT,
  refunded_at TEXT,
  refund_amount INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (buyer_member_id) REFERENCES members(id),
  FOREIGN KEY (sharer_member_id) REFERENCES members(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  line_total INTEGER NOT NULL CHECK (line_total > 0),
  distribution_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ecpay',
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  result_code TEXT,
  result_message TEXT,
  external_trade_no TEXT,
  amount INTEGER,
  is_simulated INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0, 1)),
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  UNIQUE (provider, event_key)
);

CREATE TABLE order_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('supplier', 'content', 'sharer', 'platform', 'bonus_pool')),
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

CREATE INDEX idx_orders_status ON orders(payment_status, order_status, created_at);
CREATE INDEX idx_orders_sharer ON orders(sharer_member_id, created_at);
CREATE INDEX idx_payment_events_order ON payment_events(order_id, created_at);
CREATE INDEX idx_order_allocations_beneficiary ON order_allocations(beneficiary_member_id, status);

UPDATE products
SET name = '菱烏金炭皂', updated_at = CURRENT_TIMESTAMP
WHERE product_code = 'SOAP001' AND name = '烏金炭皂';

INSERT INTO product_checkout_configs
  (product_id, environment, checkout_mode, stage_price, distribution_json)
SELECT
  id,
  'stage',
  'stage_test',
  600,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}'
FROM products
WHERE product_code = 'SOAP001'
ON CONFLICT(product_id) DO NOTHING;
