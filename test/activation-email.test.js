const test = require("node:test");
const assert = require("node:assert/strict");
const email = require("../lib/activation-email");

const environment = {
  RESEND_API_KEY: "re_test_only",
  ACTIVATION_EMAIL_FROM: "LT Test <test@example.com>",
  APP_BASE_URL: "https://example.test"
};

test("activation Email uses Resend HTTPS API without exposing the API key in content", async () => {
  let request;
  const result = await email.sendActivationEmail({
    to: "member@example.com",
    name: "<會員>",
    token: "one-time-token",
    environment,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: "email_test_123" }) };
    }
  });
  assert.deepEqual(result, { id: "email_test_123" });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.headers.Authorization, "Bearer re_test_only");
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(payload.to, ["member@example.com"]);
  assert.match(payload.html, /%2Dtime%2Dtoken|one-time-token/);
  assert.match(payload.html, /&lt;會員&gt;/);
  assert.doesNotMatch(payload.html, /re_test_only/);
});

test("activation Email rejects missing configuration and provider failures", async () => {
  await assert.rejects(
    email.sendActivationEmail({ to: "a@example.com", name: "A", token: "x", environment: {}, fetchImpl: async () => ({ ok: true }) }),
    /not configured/
  );
  await assert.rejects(
    email.sendActivationEmail({
      to: "a@example.com",
      name: "A",
      token: "x",
      environment,
      fetchImpl: async () => ({ ok: false, status: 429 })
    }),
    /rejected.*429/
  );
  await assert.rejects(
    email.sendActivationEmail({
      to: "a@example.com",
      name: "A",
      token: "x",
      environment: { ...environment, APP_BASE_URL: "http://public.example.com" },
      fetchImpl: async () => ({ ok: true })
    }),
    /not configured/
  );
});
