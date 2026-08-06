const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { applyMigrations } = require("../lib/migrations");

const root = path.join(__dirname, "..");

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/member/login`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not become ready");
}

test("member share center shows only the member's production payout dashboard", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-member-payout-test-"));
  const databasePath = path.join(directory, "test.sqlite");
  const port = await availablePort();
  const env = {
    ...process.env,
    DATABASE_PATH: databasePath,
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "test",
    COOKIE_SECURE: "false",
    SESSION_SECRET: "member-payout-test-secret-32-chars",
    INITIAL_ADMIN_EMAIL: "admin@lt-health-sales.test",
    ECPAY_MODE: "stage",
    ECPAY_STAGE_ENABLED: "true",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_CREDIT_ENABLED: "false"
  };

  const seeded = spawnSync(process.execPath, ["scripts/seed.js"], { cwd: root, env, encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db, path.join(root, "migrations"));
  const member = db.prepare("SELECT id FROM members WHERE email = 'member.lin@example.com'").get();
  const store = db.prepare("SELECT id FROM stores ORDER BY id LIMIT 1").get();
  const otherUser = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', '其他會員', '0999999999', 'other@example.test', 'unused', ?) RETURNING id`).get(store.id);
  const otherMember = db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, 'LT-OTHER', '其他會員', '0999999999', 'other@example.test') RETURNING id`).get(store.id, otherUser.id);
  const productType = db.prepare("INSERT INTO product_types (name) VALUES ('測試用品') RETURNING id").get();
  const product = db.prepare(`INSERT INTO products
    (product_code, name, type_id, product_page_url, is_active)
    VALUES ('PAYOUT001', '分潤測試商品', ?, 'https://example.test/payout', 1)
    RETURNING id, product_code, name`).get(productType.id);

  function addOrder({ orderNo, environment, isTest, beneficiaryId, amount, status, role = "sharer" }) {
    const order = db.prepare(`INSERT INTO orders
      (order_no, environment, is_test, buyer_name, total_amount, order_status, payment_status, paid_at)
      VALUES (?, ?, ?, '測試買家', 1000, 'completed', 'paid', '2026-08-06 10:00:00') RETURNING id`)
      .get(orderNo, environment, isTest);
    const item = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_code, product_name, quantity, unit_price, line_total, distribution_json)
      VALUES (?, ?, ?, ?, 1, 1000, 1000, '{}') RETURNING id`)
      .get(order.id, product.id, product.product_code, product.name);
    db.prepare(`INSERT INTO order_allocations
      (order_id, order_item_id, role, beneficiary_member_id, rate, amount, status)
      VALUES (?, ?, ?, ?, 20, ?, ?)`)
      .run(order.id, item.id, role, beneficiaryId, amount, status);
  }

  addOrder({ orderNo: "PROD-PENDING", environment: "production", isTest: 0, beneficiaryId: member.id, amount: 200, status: "payable" });
  addOrder({ orderNo: "PROD-PAID", environment: "production", isTest: 0, beneficiaryId: member.id, amount: 150, status: "paid", role: "supplier" });
  addOrder({ orderNo: "STAGE-HIDDEN", environment: "stage", isTest: 1, beneficiaryId: member.id, amount: 999, status: "paid" });
  addOrder({ orderNo: "OTHER-HIDDEN", environment: "production", isTest: 0, beneficiaryId: otherMember.id, amount: 888, status: "paid" });
  db.close();

  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilReady(baseUrl, child);
  const adminLogin = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ role: "admin", email: "admin@lt-health-sales.test", password: "password123" })
  });
  assert.equal(adminLogin.status, 302);
  const adminCookie = adminLogin.headers.get("set-cookie").split(";", 1)[0];
  const acceptanceCreation = await fetch(`${baseUrl}/admin/orders/stage-payout-acceptance`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: adminCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams()
  });
  assert.equal(acceptanceCreation.status, 200);
  const acceptanceHtml = await acceptanceCreation.text();
  assert.match(acceptanceHtml, /Stage 驗收會員已建立（密碼僅顯示這一次）/);
  assert.match(acceptanceHtml, /stage\.payout\.qa@lt-health-sales\.test/);
  assert.match(acceptanceHtml, /LTSTAGEQA001/);
  const temporaryPassword = acceptanceHtml.match(/一次性臨時密碼：<\/b><code>([^<]+)<\/code>/)?.[1];
  assert.ok(temporaryPassword);
  const duplicateCreation = await fetch(`${baseUrl}/admin/orders/stage-payout-acceptance`, {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams()
  });
  assert.equal(duplicateCreation.status, 200);
  assert.match(await duplicateCreation.text(), /Stage 驗收資料已存在/);

  const acceptanceLogin = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ role: "member", email: "stage.payout.qa@lt-health-sales.test", password: temporaryPassword })
  });
  assert.equal(acceptanceLogin.status, 302);
  const acceptanceCookie = acceptanceLogin.headers.get("set-cookie").split(";", 1)[0];
  const acceptanceDashboard = await fetch(`${baseUrl}/member/share-center`, { headers: { cookie: acceptanceCookie } });
  assert.equal(acceptanceDashboard.status, 200);
  const acceptanceDashboardHtml = await acceptanceDashboard.text();
  assert.match(acceptanceDashboardHtml, /累計分潤<strong>NT\$ 0<\/strong>/);
  assert.match(acceptanceDashboardHtml, /Stage 測試分潤（不可請領）/);
  assert.match(acceptanceDashboardHtml, /STAGEQA-PAYOUT-20260806/);
  assert.match(acceptanceDashboardHtml, /測試 NT\$ 400/);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ role: "member", email: "member.lin@example.com", password: "password123" })
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const response = await fetch(`${baseUrl}/member/share-center`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /我的分潤/);
  assert.match(html, /累計分潤<strong>NT\$ 350<\/strong>/);
  assert.match(html, /待結算<strong>NT\$ 200<\/strong>/);
  assert.match(html, /已結算<strong>NT\$ 150<\/strong>/);
  assert.match(html, /PROD-PENDING/);
  assert.match(html, /PROD-PAID/);
  assert.match(html, /供應商/);
  assert.match(html, /商品成交分享者/);
  assert.match(html, /Stage 測試分潤（不可請領）/);
  assert.match(html, /STAGE-HIDDEN/);
  assert.match(html, /測試 NT\$ 999/);
  assert.doesNotMatch(html, /OTHER-HIDDEN/);
  assert.doesNotMatch(html, /NT\$ 888/);
});
