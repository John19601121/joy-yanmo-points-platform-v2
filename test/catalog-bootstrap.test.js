const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ensureDefaultProducts } = require("../lib/catalog-bootstrap");
const { applyMigrations } = require("../lib/migrations");

const root = path.join(__dirname, "..");
const migrationsDir = path.join(root, "migrations");
const expectedDistribution = {
  supplier: 40,
  content: 20,
  sharer: 20,
  platform: 10,
  member_referral: 1,
  product_introducer: 2,
  bonus_pool: 7
};

function emptyDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-catalog-bootstrap-test-"));
  const db = new DatabaseSync(path.join(directory, "test.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  return { db, directory };
}

function assertCatalogReady(db) {
  const product = db.prepare("SELECT id, price, product_page_url FROM products WHERE product_code = 'SOAP001'").get();
  assert.equal(product.price, 600);
  assert.equal(product.product_page_url, "https://lt-health.com.tw/products/content/wujin-soap");
  const config = db.prepare("SELECT * FROM product_checkout_configs WHERE product_id = ?").get(product.id);
  assert.equal(config.stage_price, null);
  assert.equal(config.stage_offer_code, "trial_1");
  assert.deepEqual(JSON.parse(config.distribution_json), expectedDistribution);
  const offers = db.prepare(`SELECT offer_code, merchandise_amount, shipping_amount, distribution_json
    FROM product_checkout_offers WHERE product_id = ? ORDER BY sort_order`).all(product.id);
  assert.deepEqual(offers.map((offer) => [offer.offer_code, offer.merchandise_amount, offer.shipping_amount]), [
    ["trial_1", 200, 65],
    ["buy_5_get_1", 1000, 65],
    ["buy_10_get_3", 2000, 0],
    ["buy_20_get_10", 4000, 0]
  ]);
  for (const offer of offers) assert.deepEqual(JSON.parse(offer.distribution_json), expectedDistribution);
}

test("fresh initialization bootstraps SOAP001 before catalog migrations and is repeatable", () => {
  const { db, directory } = emptyDatabase();
  ensureDefaultProducts(db);
  applyMigrations(db, migrationsDir);
  assertCatalogReady(db);

  ensureDefaultProducts(db);
  applyMigrations(db, migrationsDir);
  assertCatalogReady(db);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM products WHERE product_code = 'SOAP001'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_checkout_configs").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_checkout_offers").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 11);
  db.close();
  fs.rmSync(directory, { recursive: true });
});

test("migration 010 repairs a database where migrations 001-009 ran before SOAP001 existed", () => {
  const { db, directory } = emptyDatabase();
  const oldMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-catalog-migrations-001-009-"));
  for (const file of fs.readdirSync(migrationsDir).filter((name) => /^00[1-9].*\.sql$/.test(name))) {
    fs.copyFileSync(path.join(migrationsDir, file), path.join(oldMigrationsDir, file));
  }
  applyMigrations(db, oldMigrationsDir);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM products WHERE product_code = 'SOAP001'").get().count, 0);

  ensureDefaultProducts(db);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_checkout_configs").get().count, 0);
  applyMigrations(db, migrationsDir);
  assertCatalogReady(db);

  applyMigrations(db, migrationsDir);
  assertCatalogReady(db);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_checkout_configs").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM product_checkout_offers").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 11);
  db.close();
  fs.rmSync(directory, { recursive: true });
  fs.rmSync(oldMigrationsDir, { recursive: true });
});

test("official product page migration preserves an administrator-customized URL", () => {
  const { db, directory } = emptyDatabase();
  ensureDefaultProducts(db);
  db.prepare("UPDATE products SET product_page_url = ? WHERE product_code = 'SOAP001'")
    .run("https://example.test/custom-soap");
  applyMigrations(db, migrationsDir);
  assert.equal(
    db.prepare("SELECT product_page_url FROM products WHERE product_code = 'SOAP001'").get().product_page_url,
    "https://example.test/custom-soap"
  );
  db.close();
  fs.rmSync(directory, { recursive: true });
});
