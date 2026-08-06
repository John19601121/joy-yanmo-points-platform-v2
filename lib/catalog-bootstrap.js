function ensureDefaultProducts(db) {
  const type = db.prepare("SELECT id FROM product_types WHERE name = ?").get("用品")
    || db.prepare("INSERT INTO product_types (name, sort_order, is_active) VALUES (?, 10, 1) RETURNING id").get("用品");
  const category = db.prepare("SELECT id FROM product_categories WHERE type_id = ? AND name = ?").get(type.id, "清潔用品")
    || db.prepare("INSERT INTO product_categories (type_id, name, sort_order, is_active) VALUES (?, ?, 10, 1) RETURNING id").get(type.id, "清潔用品");
  const existing = db.prepare("SELECT id FROM products WHERE product_code = ?").get("SOAP001");
  if (existing) return existing;
  return db.prepare(`
    INSERT INTO products (product_code, name, type_id, category_id, short_description, product_page_url, price, currency, payment_provider, is_active, sort_order)
    VALUES ('SOAP001', '烏金炭皂', ?, ?, '深層清潔、溫和調理的黑金炭皂', 'https://lt-health.com.tw/products/content/wujin-soap', NULL, 'TWD', 'ecpay', 1, 10)
    RETURNING id
  `).get(type.id, category.id);
}

module.exports = { ensureDefaultProducts };
