function paymentMethodLabel(value) {
  return {
    Credit_CreditCard: "信用卡付款",
    ATM_TAISHIN: "ATM 轉帳",
    CVS_CVS: "超商代碼付款"
  }[String(value || "")] || String(value || "未提供");
}

function environmentLabel(order) {
  return order.environment === "production" && !order.is_test ? "正式" : "測試";
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString("zh-TW");
}

async function postNotification(webhookUrl, payload, fetchImpl) {
  if (!webhookUrl) return { sent: false, reason: "not_configured" };
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Notification center rejected the request with ${response.status}.`);
  return { sent: true };
}

async function sendOrderNotification({
  order,
  item,
  webhookUrl = process.env.LINE_WEBHOOK_URL,
  fetchImpl = fetch
}) {
  const environment = environmentLabel(order);
  return postNotification(webhookUrl, {
    type: "lt_order_created",
    orderNo: order.order_no,
    productCode: item?.product_code || "",
    productName: item?.product_name || "",
    subtotalAmount: order.subtotal_amount || item?.line_total || order.total_amount,
    shippingAmount: order.shipping_amount || 0,
    amount: order.total_amount,
    paymentStatus: order.payment_status,
    environment: order.environment,
    isTest: Boolean(order.is_test),
    message: `【LT 新訂單通知｜${environment}】\n訂單：${order.order_no}\n商品：${item?.product_name || item?.product_code || "未提供"}\n商品金額：NT$ ${formatAmount(order.subtotal_amount || item?.line_total || order.total_amount)}\n運費：NT$ ${formatAmount(order.shipping_amount || 0)}\n訂單總額：NT$ ${formatAmount(order.total_amount)}\n狀態：等待綠界付款`
  }, fetchImpl);
}

async function sendPaymentNotification({
  order,
  webhookUrl = process.env.LINE_WEBHOOK_URL,
  fetchImpl = fetch
}) {
  const environment = environmentLabel(order);
  return postNotification(webhookUrl, {
    type: "lt_payment_succeeded",
    orderNo: order.order_no,
    amount: order.total_amount,
    paymentStatus: order.payment_status,
    paymentMethod: paymentMethodLabel(order.payment_method),
    environment: order.environment,
    isTest: Boolean(order.is_test),
    message: `【LT 付款成功通知｜${environment}】\n訂單：${order.order_no}\n金額：NT$ ${formatAmount(order.total_amount)}\n付款方式：${paymentMethodLabel(order.payment_method)}\n狀態：付款成功`
  }, fetchImpl);
}

module.exports = { paymentMethodLabel, sendOrderNotification, sendPaymentNotification };
