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

test("Stage admin checkout readiness follows the displayed Stage checks", () => {
  const stageEnvironment = {
    ECPAY_MODE: "stage",
    ECPAY_STAGE_ENABLED: "true",
    ECPAY_MERCHANT_ID: "test-merchant",
    ECPAY_HASH_KEY: "test-key",
    ECPAY_HASH_IV: "test-iv",
    APP_BASE_URL: "https://example.test",
    ECPAY_CREDIT_ENABLED: "true",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_CREDIT_ENABLED: "false"
  };

  assert.deepEqual(ecpay.stageCheckoutReadiness(stageEnvironment), {
    modeSelected: true,
    stageEnabled: true,
    credentialsReady: true,
    creditEnabled: true,
    checkoutEnabled: true
  });

  assert.equal(ecpay.stageCheckoutReadiness({
    ...stageEnvironment,
    ECPAY_CREDIT_ENABLED: "false"
  }).checkoutEnabled, false);

  const productionSelected = ecpay.stageCheckoutReadiness({
    ...stageEnvironment,
    ECPAY_MODE: "production"
  });
  assert.equal(productionSelected.stageEnabled, true);
  assert.equal(productionSelected.checkoutEnabled, false);
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

test("production credentials stay isolated and require every live-collection lock", () => {
  const shared = {
    ECPAY_MODE: "production",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_MERCHANT_ID: "3222651",
    ECPAY_PRODUCTION_HASH_KEY: "production-key",
    ECPAY_PRODUCTION_HASH_IV: "production-iv",
    ECPAY_PRODUCTION_CREDIT_ENABLED: "true",
    ECPAY_MERCHANT_ID: "3002607",
    ECPAY_HASH_KEY: "stage-key",
    ECPAY_HASH_IV: "stage-iv",
    APP_BASE_URL: "https://example.test"
  };
  const locked = ecpay.paymentConfig(shared);
  assert.equal(locked.hashKey, "production-key");
  assert.equal(locked.hashIv, "production-iv");
  assert.equal(locked.productionEnabled, false);
  assert.throws(() => ecpay.assertProductionCheckoutAllowed(locked), /not configured or approved/);

  const enabled = ecpay.paymentConfig({ ...shared, ECPAY_PRODUCTION_ENABLED: "true" });
  assert.equal(enabled.productionEnabled, true);
  assert.doesNotThrow(() => ecpay.assertProductionCheckoutAllowed(enabled));
  assert.equal(
    ecpay.paymentConfigForMerchantId("3222651", { ...shared, ECPAY_PRODUCTION_ENABLED: "true" }).merchantId,
    "3222651"
  );

  const wrongMerchant = ecpay.paymentConfig({
    ...shared,
    ECPAY_PRODUCTION_ENABLED: "true",
    ECPAY_PRODUCTION_MERCHANT_ID: "3002607"
  });
  assert.equal(wrongMerchant.productionEnabled, false);
  assert.throws(() => ecpay.assertProductionCheckoutAllowed(wrongMerchant), /not configured or approved/);
});

test("callback credentials remain available after new Production collection is disabled", () => {
  const environment = {
    ECPAY_MODE: "production",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_MERCHANT_ID: "3222651",
    ECPAY_PRODUCTION_HASH_KEY: "production-key",
    ECPAY_PRODUCTION_HASH_IV: "production-iv",
    ECPAY_PRODUCTION_CREDIT_ENABLED: "false"
  };
  const checkout = ecpay.paymentConfig(environment);
  assert.equal(checkout.productionEnabled, false);
  assert.throws(() => ecpay.assertProductionCheckoutAllowed(checkout), /not configured or approved/);

  const callback = ecpay.paymentConfigForMerchantId("3222651", environment);
  assert.equal(callback.mode, "production");
  assert.equal(callback.callbackEnabled, true);
  assert.doesNotThrow(() => ecpay.assertCallbackAllowed(callback));
});

test("unfinished Stage callbacks remain identifiable after selecting Production mode", () => {
  const environment = {
    ECPAY_MODE: "production",
    ECPAY_STAGE_ENABLED: "false",
    ECPAY_MERCHANT_ID: "3002607",
    ECPAY_HASH_KEY: "stage-key",
    ECPAY_HASH_IV: "stage-iv",
    ECPAY_PRODUCTION_ENABLED: "false",
    ECPAY_PRODUCTION_MERCHANT_ID: "3222651",
    ECPAY_PRODUCTION_HASH_KEY: "production-key",
    ECPAY_PRODUCTION_HASH_IV: "production-iv"
  };
  const callback = ecpay.paymentConfigForMerchantId("3002607", environment);
  assert.equal(callback.mode, "stage");
  assert.equal(callback.stageEnabled, false);
  assert.equal(callback.callbackEnabled, true);
  assert.doesNotThrow(() => ecpay.assertCallbackAllowed(callback));
});

test("production checkout parameters are signed only with production configuration", () => {
  const config = ecpay.paymentConfig({
    ECPAY_MODE: "production",
    ECPAY_PRODUCTION_ENABLED: "true",
    ECPAY_PRODUCTION_MERCHANT_ID: "3222651",
    ECPAY_PRODUCTION_HASH_KEY: "production-key",
    ECPAY_PRODUCTION_HASH_IV: "production-iv",
    ECPAY_PRODUCTION_CREDIT_ENABLED: "true",
    APP_BASE_URL: "https://example.test"
  });
  const order = { order_no: "LT2608031200000001", total_amount: 265 };
  const item = { product_name: "菱烏金炭皂體驗組", quantity: 1 };
  const parameters = ecpay.buildCheckoutParameters(order, item, config, new Date("2026-08-03T12:00:00Z"));
  assert.equal(parameters.MerchantID, "3222651");
  assert.equal(parameters.TotalAmount, "265");
  assert.equal(parameters.CustomField2, "LT_PRODUCTION");
  assert.equal(ecpay.checkoutGatewayUrl(config.mode), ecpay.PRODUCTION_GATEWAY_URL);
  assert.equal(ecpay.verifyCheckMacValue(parameters, config), true);
  assert.equal(ecpay.verifyCheckMacValue(parameters, { hashKey: "stage-key", hashIv: "stage-iv" }), false);
});
