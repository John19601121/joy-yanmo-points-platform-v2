const test = require("node:test");
const assert = require("node:assert/strict");
const ecpay = require("../lib/ecpay");

const officialCredentials = {
  hashKey: "pwFHCqoQZGmho4w6",
  hashIv: "EkRm7iFT261dpevs"
};

test("ECPay checksum matches the official AioCheckOut SHA256 example", () => {
  const parameters = {
    TradeDesc: "促銷方案",
    PaymentType: "aio",
    MerchantTradeDate: "2023/03/12 15:30:23",
    MerchantTradeNo: "ecpay20230312153023",
    MerchantID: "3002607",
    ReturnURL: "https://www.ecpay.com.tw/receive.php",
    ItemName: "Apple iphone 15",
    TotalAmount: "30000",
    ChoosePayment: "ALL",
    EncryptType: "1"
  };
  assert.equal(
    ecpay.createCheckMacValue(parameters, officialCredentials),
    "6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840"
  );
});

test("ECPay checksum verification is constant-shape and rejects tampering", () => {
  const parameters = { MerchantID: "test", TradeAmt: "600" };
  const credentials = { hashKey: "test-key", hashIv: "test-iv" };
  const signed = { ...parameters, CheckMacValue: ecpay.createCheckMacValue(parameters, credentials) };
  assert.equal(ecpay.verifyCheckMacValue(signed, credentials), true);
  assert.equal(ecpay.verifyCheckMacValue({ ...signed, TradeAmt: "601" }, credentials), false);
  assert.equal(ecpay.verifyCheckMacValue({ ...signed, CheckMacValue: "bad" }, credentials), false);
});

test("stage checkout remains locked unless every safety switch is present", () => {
  const disabled = ecpay.paymentConfig({});
  assert.equal(disabled.stageEnabled, false);
  assert.throws(() => ecpay.assertStageCheckoutAllowed(disabled), /not configured or approved/);

  const configured = ecpay.paymentConfig({
    ECPAY_MODE: "stage",
    ECPAY_STAGE_ENABLED: "true",
    ECPAY_MERCHANT_ID: "test-merchant",
    ECPAY_HASH_KEY: "test-key",
    ECPAY_HASH_IV: "test-iv",
    APP_BASE_URL: "https://example.test",
    ECPAY_CREDIT_ENABLED: "true"
  });
  assert.equal(configured.stageEnabled, true);
  assert.doesNotThrow(() => ecpay.assertStageCheckoutAllowed(configured));

  const production = { ...configured, mode: "production" };
  assert.throws(() => ecpay.assertStageCheckoutAllowed(production), /Production.*not enabled/);
});

test("checkout parameters keep server notification and browser result URLs separate", () => {
  const config = ecpay.paymentConfig({
    ECPAY_MODE: "stage",
    ECPAY_STAGE_ENABLED: "true",
    ECPAY_MERCHANT_ID: "test-merchant",
    ECPAY_HASH_KEY: "test-key",
    ECPAY_HASH_IV: "test-iv",
    APP_BASE_URL: "https://example.test",
    ECPAY_CREDIT_ENABLED: "true"
  });
  const order = { order_no: "LT2607261200000001", total_amount: 600 };
  const item = { product_name: "菱烏金炭皂", quantity: 1 };
  const parameters = ecpay.buildCheckoutParameters(order, item, config, new Date("2026-07-26T12:00:00Z"));
  assert.equal(parameters.ReturnURL, "https://example.test/payments/ecpay/return");
  assert.equal(parameters.OrderResultURL, "https://example.test/payments/ecpay/order-result");
  assert.notEqual(parameters.ReturnURL, parameters.OrderResultURL);
  assert.equal(parameters.ChoosePayment, "Credit");
  assert.equal(parameters.TotalAmount, "600");
  assert.equal(ecpay.verifyCheckMacValue(parameters, config), true);
});
