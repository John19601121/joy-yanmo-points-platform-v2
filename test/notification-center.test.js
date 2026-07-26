const test = require("node:test");
const assert = require("node:assert/strict");
const notificationCenter = require("../lib/notification-center");

test("notification center is silent when no webhook is configured", async () => {
  assert.deepEqual(await notificationCenter.sendPaymentNotification({
    order: { order_no: "LTTEST", total_amount: 600, payment_status: "paid", environment: "stage", is_test: 1 },
    webhookUrl: ""
  }), { sent: false, reason: "not_configured" });
});

test("payment notification contains test status but no gateway credentials", async () => {
  let request;
  const result = await notificationCenter.sendPaymentNotification({
    order: { order_no: "LTTEST", total_amount: 600, payment_status: "paid", environment: "stage", is_test: 1 },
    webhookUrl: "https://example.test/webhook",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200 };
    }
  });
  assert.deepEqual(result, { sent: true });
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.orderNo, "LTTEST");
  assert.equal(payload.amount, 600);
  assert.equal(payload.isTest, true);
  assert.doesNotMatch(request.options.body, /HashKey|HashIV|MerchantID/);
});
