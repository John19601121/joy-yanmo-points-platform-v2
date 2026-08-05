ALTER TABLE product_checkout_configs ADD COLUMN stage_offer_code TEXT;

ALTER TABLE order_items ADD COLUMN supplier_member_id_snapshot INTEGER REFERENCES members(id);
ALTER TABLE order_items ADD COLUMN content_member_id_snapshot INTEGER REFERENCES members(id);
ALTER TABLE order_items ADD COLUMN platform_member_id_snapshot INTEGER REFERENCES members(id);

CREATE TABLE product_revenue_beneficiaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('supplier', 'content', 'platform')),
  beneficiary_member_id INTEGER NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (beneficiary_member_id) REFERENCES members(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  UNIQUE (product_id, role)
);

CREATE INDEX idx_product_revenue_beneficiaries_member
  ON product_revenue_beneficiaries(beneficiary_member_id, role);

UPDATE products
SET price = 600, updated_at = CURRENT_TIMESTAMP
WHERE product_code = 'SOAP001' AND price IS NULL;

-- Convert the first real SOAP001 checkout offer into the shared Stage/Production
-- source of truth. stage_price remains only as a nullable legacy column so an
-- already-applied migration never needs to be rewritten.
UPDATE product_checkout_configs
SET stage_offer_code = 'trial_1',
    stage_price = NULL,
    distribution_json = '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}',
    updated_at = CURRENT_TIMESTAMP
WHERE product_id = (SELECT id FROM products WHERE product_code = 'SOAP001');

UPDATE product_checkout_offers
SET distribution_json = '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}',
    updated_at = CURRENT_TIMESTAMP
WHERE product_id = (SELECT id FROM products WHERE product_code = 'SOAP001');
