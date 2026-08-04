const crypto = require("node:crypto");

const STAGE_GATEWAY_URL = "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";
const PRODUCTION_GATEWAY_URL = "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5";
const APPROVED_PRODUCTION_MERCHANT_ID = "3222651";

function formUrlEncode(value) {
  const encoded = new URLSearchParams({ value: String(value ?? "") }).toString().slice("value=".length);
  return encoded
    .replace(/%2D/gi, "-")
    .replace(/%5F/gi, "_")
    .replace(/%2E/gi, ".")
    .replace(/%21/gi, "!")
    .replace(/%2A/gi, "*")
    .replace(/%28/gi, "(")
    .replace(/%29/gi, ")");
}

function createCheckMacValue(parameters, { hashKey, hashIv }) {
  if (!hashKey || !hashIv) throw new Error("ECPay checksum credentials are missing.");
  const keys = Object.keys(parameters)
    .filter((key) => key !== "CheckMacValue" && parameters[key] !== undefined && parameters[key] !== null)
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase(), "en"));
  const query = keys.map((key) => `${key}=${parameters[key]}`).join("&");
  const source = `HashKey=${hashKey}&${query}&HashIV=${hashIv}`;
  return crypto.createHash("sha256").update(formUrlEncode(source).toLowerCase()).digest("hex").toUpperCase();
}

function verifyCheckMacValue(parameters, credentials) {
  const received = String(parameters.CheckMacValue || "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(received)) return false;
  const expected = createCheckMacValue(parameters, credentials);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function taipeiTradeDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}/${value.month}/${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function absoluteHttpsUrl(baseUrl, pathname) {
  const base = new URL(String(baseUrl || ""));
  if (base.protocol !== "https:") throw new Error("ECPay callback base URL must use HTTPS.");
  return new URL(pathname, `${base.origin}/`).toString();
}

function paymentConfig(environment = process.env) {
  const mode = String(environment.ECPAY_MODE || "disabled").toLowerCase();
  const production = mode === "production";
  const merchantId = String((production
    ? environment.ECPAY_PRODUCTION_MERCHANT_ID
    : environment.ECPAY_MERCHANT_ID) || "").trim();
  const hashKey = String((production
    ? environment.ECPAY_PRODUCTION_HASH_KEY
    : environment.ECPAY_HASH_KEY) || "");
  const hashIv = String((production
    ? environment.ECPAY_PRODUCTION_HASH_IV
    : environment.ECPAY_HASH_IV) || "");
  const appBaseUrl = String(environment.APP_BASE_URL || "").trim();
  const stageApproved = environment.ECPAY_STAGE_ENABLED === "true";
  const productionApproved = environment.ECPAY_PRODUCTION_ENABLED === "true";
  const productionMerchantApproved = merchantId === APPROVED_PRODUCTION_MERCHANT_ID;
  const credentialsReady = Boolean(merchantId && hashKey && hashIv && appBaseUrl);
  const stageEnabled = mode === "stage" && stageApproved && credentialsReady;
  const productionEnabled = production
    && productionApproved
    && productionMerchantApproved
    && credentialsReady;
  return {
    mode,
    merchantId,
    hashKey,
    hashIv,
    appBaseUrl,
    credentialsReady,
    stageEnabled,
    productionEnabled,
    productionMerchantApproved,
    creditEnabled: production
      ? environment.ECPAY_PRODUCTION_CREDIT_ENABLED === "true"
      : environment.ECPAY_CREDIT_ENABLED === "true",
    atmEnabled: production
      ? environment.ECPAY_PRODUCTION_ATM_ENABLED === "true"
      : environment.ECPAY_ATM_ENABLED === "true",
    cvsEnabled: production
      ? environment.ECPAY_PRODUCTION_CVS_ENABLED === "true"
      : environment.ECPAY_CVS_ENABLED === "true"
  };
}

function stageCheckoutReadiness(environment = process.env) {
  const selectedConfig = paymentConfig(environment);
  const stageConfig = paymentConfig({ ...environment, ECPAY_MODE: "stage" });
  const readiness = {
    modeSelected: selectedConfig.mode === "stage",
    stageEnabled: stageConfig.stageEnabled,
    credentialsReady: stageConfig.credentialsReady,
    creditEnabled: stageConfig.creditEnabled
  };
  return {
    ...readiness,
    checkoutEnabled: Object.values(readiness).every(Boolean)
  };
}

function paymentConfigForMerchantId(merchantId, environment = process.env) {
  const requestedMerchantId = String(merchantId || "").trim();
  if (!requestedMerchantId) return null;
  const matches = ["stage", "production"].map((mode) => {
    const config = paymentConfig({ ...environment, ECPAY_MODE: mode });
    const callbackCredentialsReady = Boolean(config.merchantId && config.hashKey && config.hashIv);
    const callbackEnabled = callbackCredentialsReady
      && (mode === "stage" || config.productionMerchantApproved);
    return { ...config, callbackCredentialsReady, callbackEnabled };
  }).filter((config) => config.merchantId === requestedMerchantId && config.callbackEnabled);
  return matches.length === 1 ? matches[0] : null;
}

function assertStageCheckoutAllowed(config) {
  if (config.mode === "production") {
    throw new Error("Production ECPay checkout is not enabled in this stage.");
  }
  if (!config.stageEnabled) throw new Error("ECPay stage checkout is not configured or approved.");
  if (!config.creditEnabled) throw new Error("ECPay stage credit-card testing is disabled.");
}

function assertProductionCheckoutAllowed(config) {
  if (config.mode !== "production") throw new Error("ECPay production checkout is not selected.");
  if (!config.productionEnabled) throw new Error("ECPay production checkout is not configured or approved.");
  if (!config.productionMerchantApproved) throw new Error("ECPay production MerchantID is not approved.");
  if (!config.creditEnabled) throw new Error("ECPay production credit-card collection is disabled.");
}

function assertCheckoutAllowed(config) {
  if (config.mode === "stage") return assertStageCheckoutAllowed(config);
  return assertProductionCheckoutAllowed(config);
}

function assertCallbackAllowed(config) {
  if (config && config.callbackEnabled && (config.mode === "stage" || config.mode === "production")) return;
  throw new Error("ECPay callback credentials are not configured or approved.");
}

function checkoutGatewayUrl(mode) {
  return mode === "production" ? PRODUCTION_GATEWAY_URL : STAGE_GATEWAY_URL;
}

function callbackFailureCode(error) {
  const message = String(error?.message || "");
  if (message.includes("MerchantID is not active") || message.includes("MerchantID does not match")) {
    return "merchant_rejected";
  }
  if (message.includes("CheckMacValue")) return "checkmac_rejected";
  if (message.includes("active payment environment")) return "order_environment_rejected";
  if (message.includes("payment amount")) return "amount_rejected";
  if (message.includes("Simulated ECPay payment")) return "simulation_rejected";
  if (message.includes("callback credentials")) return "callback_disabled";
  return "request_rejected";
}

function callbackDiagnostic(route, payload = {}, config = null, details = {}) {
  const allowedReasons = new Set([
    "merchant_rejected",
    "checkmac_rejected",
    "order_environment_rejected",
    "amount_rejected",
    "simulation_rejected",
    "callback_disabled",
    "request_rejected"
  ]);
  const orderNo = String(payload.MerchantTradeNo || "");
  const resultCode = String(payload.RtnCode || "");
  const entry = {
    event: "ecpay_callback",
    route: route === "order-result" ? "order-result" : "return",
    environment: ["stage", "production"].includes(config?.mode) ? config.mode : "unknown",
    outcome: ["received", "accepted", "rejected"].includes(details.outcome)
      ? details.outcome
      : "received",
    order_ref: orderNo
      ? crypto.createHash("sha256").update(orderNo).digest("hex").slice(0, 12)
      : "missing",
    merchant_matched: Boolean(config && String(payload.MerchantID || "") === config.merchantId),
    checkmac_present: /^[A-F0-9]{64}$/i.test(String(payload.CheckMacValue || "")),
    result_code: /^\d{1,4}$/.test(resultCode) ? resultCode : "unknown",
    simulated: String(payload.SimulatePaid || "0") === "1"
  };
  if (details.reason) {
    entry.reason = allowedReasons.has(details.reason) ? details.reason : "request_rejected";
  }
  if (typeof details.paid === "boolean") entry.paid = details.paid;
  if (typeof details.duplicate === "boolean") entry.duplicate = details.duplicate;
  return entry;
}

function buildCheckoutParameters(order, item, config, date = new Date()) {
  assertCheckoutAllowed(config);
  const production = config.mode === "production";
  const parameters = {
    MerchantID: config.merchantId,
    MerchantTradeNo: order.order_no,
    MerchantTradeDate: taipeiTradeDate(date),
    PaymentType: "aio",
    TotalAmount: String(order.total_amount),
    TradeDesc: production ? "LT Health Order" : "LT Health Stage Order",
    ItemName: `${item.product_name} x ${item.quantity}`.slice(0, 400),
    ReturnURL: absoluteHttpsUrl(config.appBaseUrl, "/payments/ecpay/return"),
    ChoosePayment: "Credit",
    EncryptType: "1",
    ClientBackURL: absoluteHttpsUrl(config.appBaseUrl, `/payment/result?order=${encodeURIComponent(order.order_no)}`),
    NeedExtraPaidInfo: "N",
    CustomField1: order.order_no,
    CustomField2: production ? "LT_PRODUCTION" : "LT_STAGE_TEST"
  };
  if (production) {
    parameters.OrderResultURL = absoluteHttpsUrl(config.appBaseUrl, "/payments/ecpay/order-result");
  }
  return {
    ...parameters,
    CheckMacValue: createCheckMacValue(parameters, config)
  };
}

module.exports = {
  STAGE_GATEWAY_URL,
  PRODUCTION_GATEWAY_URL,
  APPROVED_PRODUCTION_MERCHANT_ID,
  formUrlEncode,
  createCheckMacValue,
  verifyCheckMacValue,
  taipeiTradeDate,
  paymentConfig,
  stageCheckoutReadiness,
  paymentConfigForMerchantId,
  assertStageCheckoutAllowed,
  assertProductionCheckoutAllowed,
  assertCheckoutAllowed,
  assertCallbackAllowed,
  checkoutGatewayUrl,
  callbackFailureCode,
  callbackDiagnostic,
  buildCheckoutParameters
};
