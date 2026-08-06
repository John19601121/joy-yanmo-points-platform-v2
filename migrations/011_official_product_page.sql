-- Replace only the retired bootstrap URL. Administrator-customized product
-- pages remain untouched.
UPDATE products
SET product_page_url = 'https://lt-health.com.tw/products/content/wujin-soap',
    updated_at = CURRENT_TIMESTAMP
WHERE product_code = 'SOAP001'
  AND product_page_url = 'https://opx-1.my.canva.site/daho3zigbkc';
