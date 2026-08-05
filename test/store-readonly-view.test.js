const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

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
      const response = await fetch(`${baseUrl}/admin/login`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not become ready");
}

test("headquarters read-only store view can list only that store's members", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lt-store-readonly-test-"));
  const databasePath = path.join(directory, "test.sqlite");
  const port = await availablePort();
  const env = {
    ...process.env,
    DATABASE_PATH: databasePath,
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "test",
    COOKIE_SECURE: "false",
    SESSION_SECRET: "store-readonly-view-test-secret-32-chars"
  };

  const seeded = spawnSync(process.execPath, ["scripts/seed.js"], { cwd: root, env, encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);

  const db = new DatabaseSync(databasePath);
  const targetStore = db.prepare("SELECT id FROM stores WHERE platform_slug = 'taipei-xinyi'").get();
  const otherStore = db.prepare(`INSERT INTO stores (store_name, contact_name, phone, email, platform_slug)
    VALUES ('隔離測試分店', '測試店長', '02-0000-0000', 'isolated-store@example.test', 'isolated-store') RETURNING id`).get();
  const otherUser = db.prepare(`INSERT INTO users (role, name, phone, email, password_hash, store_id)
    VALUES ('member', '不應顯示會員', '0999999999', 'isolated-member@example.test', 'unused', ?) RETURNING id`).get(otherStore.id);
  db.prepare(`INSERT INTO members (store_id, user_id, member_code, name, phone, email)
    VALUES (?, ?, 'LT-ISOLATED', '不應顯示會員', '0999999999', 'isolated-member@example.test')`).run(otherStore.id, otherUser.id);
  db.close();

  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntilReady(baseUrl, child);
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ role: "admin", email: "admin@lt-health-sales.test", password: "password123" })
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const dashboard = await fetch(`${baseUrl}/admin/stores/${targetStore.id}/view`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, new RegExp(`/admin/stores/${targetStore.id}/members`));
  assert.doesNotMatch(dashboardHtml, /href="\/store\/deductions"/);
  assert.doesNotMatch(dashboardHtml, /action="\/store\/members"/);
  assert.doesNotMatch(dashboardHtml, /<h2>新增會員<\/h2>/);

  const storeLogin = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ role: "store", email: "taipei@lt-health-sales.test", password: "password123" })
  });
  assert.equal(storeLogin.status, 302);
  const storeCookie = storeLogin.headers.get("set-cookie").split(";", 1)[0];
  const storeDashboard = await fetch(`${baseUrl}/store/dashboard`, { headers: { cookie: storeCookie } });
  assert.equal(storeDashboard.status, 200);
  const storeDashboardHtml = await storeDashboard.text();
  assert.match(storeDashboardHtml, /href="\/store\/deductions"/);
  assert.match(storeDashboardHtml, /action="\/store\/members"/);
  assert.match(storeDashboardHtml, /<h2>新增會員<\/h2>/);

  const memberList = await fetch(`${baseUrl}/admin/stores/${targetStore.id}/members`, { headers: { cookie } });
  assert.equal(memberList.status, 200);
  const memberListHtml = await memberList.text();
  assert.match(memberListHtml, /林雅婷/);
  assert.doesNotMatch(memberListHtml, /不應顯示會員/);
  assert.doesNotMatch(memberListHtml, /\/store\/members\/new/);
  assert.doesNotMatch(memberListHtml, />詳細<\/a>/);

  const storeOnlyRoute = await fetch(`${baseUrl}/store/members`, { headers: { cookie } });
  assert.equal(storeOnlyRoute.status, 403);
});
