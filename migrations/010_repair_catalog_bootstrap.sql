-- Repair databases initialized before SOAP001 was bootstrapped. Every statement
-- is additive or limited to an unset/legacy default, so rerunning the SQL is safe.
UPDATE products
SET price = 600, updated_at = CURRENT_TIMESTAMP
WHERE product_code = 'SOAP001' AND price IS NULL;

INSERT INTO product_checkout_configs
  (product_id, environment, checkout_mode, stage_price, distribution_json, stage_offer_code)
SELECT
  id,
  'stage',
  'stage_test',
  NULL,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}',
  'trial_1'
FROM products
WHERE product_code = 'SOAP001'
ON CONFLICT(product_id) DO NOTHING;

UPDATE product_checkout_configs
SET stage_offer_code = 'trial_1',
    stage_price = NULL,
    distribution_json = '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}',
    updated_at = CURRENT_TIMESTAMP
WHERE product_id = (SELECT id FROM products WHERE product_code = 'SOAP001')
  AND stage_offer_code IS NULL
  AND distribution_json = '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}';

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'trial_1', '體驗組｜1個', 1, 0, 200, 65,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}', 10
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'buy_5_get_1', '買5送1', 5, 1, 1000, 65,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}', 20
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'buy_10_get_3', '買10送3', 10, 3, 2000, 0,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}', 30
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

INSERT INTO product_checkout_offers
  (product_id, offer_code, display_name, paid_quantity, bonus_quantity,
   merchandise_amount, shipping_amount, distribution_json, sort_order)
SELECT id, 'buy_20_get_10', '買20送10', 20, 10, 4000, 0,
  '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}', 40
FROM products WHERE product_code = 'SOAP001'
ON CONFLICT(product_id, offer_code) DO NOTHING;

UPDATE product_checkout_offers
SET distribution_json = '{"supplier":40,"content":20,"sharer":20,"platform":10,"member_referral":1,"product_introducer":2,"bonus_pool":7}',
    updated_at = CURRENT_TIMESTAMP
WHERE product_id = (SELECT id FROM products WHERE product_code = 'SOAP001')
  AND distribution_json = '{"supplier":40,"content":20,"sharer":20,"platform":10,"bonus_pool":10}';
