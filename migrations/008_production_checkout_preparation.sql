ALTER TABLE orders ADD COLUMN subtotal_amount INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0);
ALTER TABLE orders ADD COLUMN shipping_amount INTEGER NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0);
ALTER TABLE orders ADD COLUMN offer_code TEXT;
ALTER TABLE orders ADD COLUMN receiver_name TEXT;
ALTER TABLE orders ADD COLUMN receiver_phone TEXT;
ALTER TABLE orders ADD COLUMN shipping_postal_code TEXT;
ALTER TABLE orders ADD COLUMN shipping_address TEXT;
ALTER TABLE orders ADD COLUMN checkout_source TEXT;
ALTER TABLE orders ADD COLUMN checkout_token_hash TEXT;

ALTER TABLE order_items ADD COLUMN offer_code TEXT;
ALTER TABLE order_items ADD COLUMN paid_quantity INTEGER NOT NULL DEFAULT 1 CHECK (paid_quantity > 0);
ALTER TABLE order_items ADD COLUMN bonus_quantity INTEGER NOT NULL DEFAULT 0 CHECK (bonus_quantity >= 0);

CREATE TABLE product_checkout_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  offer_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  paid_quantity INTEGER NOT NULL CHECK (paid_quantity > 0),
  bonus_quantity INTEGER NOT NULL DEFAULT 0 CHECK (bonus_quantity >= 0),
  merchandise_amount INTEGER NOT NULL CHECK (merchandise_amount > 0),
  shipping_amount INTEGER NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'TWD',
  distribution_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE (product_id, offer_code)
);

CREATE INDEX idx_product_checkout_offers_active
  ON product_checkout_offers(product_id, is_active, sort_order);
CREATE UNIQUE INDEX idx_orders_checkout_token
  ON orders(checkout_token_hash) WHERE checkout_token_hash IS NOT NULL;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'trial_1', '體驗組｜1個', 1, 0, 200, 65,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}', 10
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'buy_5_get_1', '買5送1', 5, 1, 1000, 65,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}', 20
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'buy_10_get_3', '買10送3', 10, 3, 2000, 0,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}', 30
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'buy_20_get_10', '買20送10', 20, 10, 4000, 0,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}', 40
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;
