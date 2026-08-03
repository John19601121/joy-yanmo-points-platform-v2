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
  assert.equal(payload.paymentMethod, "未提供");
  assert.doesNotMatch(request.options.body, /HashKey|HashIV|MerchantID/);
});

test("production order notification separates merchandise, shipping and total", async () => {
  let payload;
  await notificationCenter.sendOrderNotification({
    order: {
      order_no: "LTPRODUCTION",
      subtotal_amount: 200,
      shipping_amount: 65,
      total_amount: 265,
      payment_status: "pending",
      environment: "production",
      is_test: 0
    },
    item: { product_code: "SOAP001", product_name: "菱烏金炭皂｜體驗組｜1個" },
    webhookUrl: "https://example.test/webhook",
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200 };
    }
  });
  assert.equal(payload.subtotalAmount, 200);
  assert.equal(payload.shippingAmount, 65);
  assert.equal(payload.amount, 265);
  assert.match(payload.message, /正式/);
  assert.match(payload.message, /等待綠界付款/);
});

test("ECPay technical credit-card value is shown in Chinese", async () => {
  let payload;
  await notificationCenter.sendPaymentNotification({
    order: {
      order_no: "LTPAID",
      total_amount: 265,
      payment_status: "paid",
      payment_method: "Credit_CreditCard",
      environment: "production",
      is_test: 0
    },
    webhookUrl: "https://example.test/webhook",
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200 };
    }
  });
  assert.equal(payload.paymentMethod, "信用卡付款");
  assert.match(payload.message, /信用卡付款/);
  assert.doesNotMatch(payload.message, /Credit_CreditCard/);
});
