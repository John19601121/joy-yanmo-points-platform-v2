const crypto = require("node:crypto");

const STAGE_GATEWAY_URL = "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";
const PRODUCTION_GATEWAY_URL = "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5";

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
  const merchantId = String(environment.ECPAY_MERCHANT_ID || "").trim();
  const hashKey = String(environment.ECPAY_HASH_KEY || "");
  const hashIv = String(environment.ECPAY_HASH_IV || "");
  const appBaseUrl = String(environment.APP_BASE_URL || "").trim();
  const stageApproved = environment.ECPAY_STAGE_ENABLED === "true";
  const credentialsReady = Boolean(merchantId && hashKey && hashIv && appBaseUrl);
  const stageEnabled = mode === "stage" && stageApproved && credentialsReady;
  return {
    mode,
    merchantId,
    hashKey,
    hashIv,
    appBaseUrl,
    credentialsReady,
    stageEnabled,
    creditEnabled: environment.ECPAY_CREDIT_ENABLED === "true",
    atmEnabled: environment.ECPAY_ATM_ENABLED === "true",
    cvsEnabled: environment.ECPAY_CVS_ENABLED === "true"
  };
}

function assertStageCheckoutAllowed(config) {
  if (config.mode === "production") {
    throw new Error("Production ECPay checkout is not enabled in this stage.");
  }
  if (!config.stageEnabled) throw new Error("ECPay stage checkout is not configured or approved.");
  if (!config.creditEnabled) throw new Error("ECPay stage credit-card testing is disabled.");
}

function checkoutGatewayUrl(mode) {
  return mode === "production" ? PRODUCTION_GATEWAY_URL : STAGE_GATEWAY_URL;
}

function buildCheckoutParameters(order, item, config, date = new Date()) {
  assertStageCheckoutAllowed(config);
  const parameters = {
    MerchantID: config.merchantId,
    MerchantTradeNo: order.order_no,
    MerchantTradeDate: taipeiTradeDate(date),
    PaymentType: "aio",
    TotalAmount: String(order.total_amount),
    TradeDesc: "LT Health Stage Order",
    ItemName: `${item.product_name} x ${item.quantity}`.slice(0, 400),
    ReturnURL: absoluteHttpsUrl(config.appBaseUrl, "/payments/ecpay/return"),
    ChoosePayment: "Credit",
    EncryptType: "1",
    ClientBackURL: absoluteHttpsUrl(config.appBaseUrl, `/payment/result?order=${encodeURIComponent(order.order_no)}`),
    OrderResultURL: absoluteHttpsUrl(config.appBaseUrl, "/payments/ecpay/order-result"),
    NeedExtraPaidInfo: "N",
    CustomField1: order.order_no,
    CustomField2: "LT_STAGE_TEST"
  };
  return {
    ...parameters,
    CheckMacValue: createCheckMacValue(parameters, config)
  };
}

module.exports = {
  STAGE_GATEWAY_URL,
  PRODUCTION_GATEWAY_URL,
  formUrlEncode,
  createCheckMacValue,
  verifyCheckMacValue,
  taipeiTradeDate,
  paymentConfig,
  assertStageCheckoutAllowed,
  checkoutGatewayUrl,
  buildCheckoutParameters
};
