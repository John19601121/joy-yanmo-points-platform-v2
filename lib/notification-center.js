async function sendPaymentNotification({
  order,
  webhookUrl = process.env.LINE_WEBHOOK_URL,
  fetchImpl = fetch
}) {
  if (!webhookUrl) return { sent: false, reason: "not_configured" };
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "lt_stage_payment",
      orderNo: order.order_no,
      amount: order.total_amount,
      paymentStatus: order.payment_status,
      environment: order.environment,
      isTest: Boolean(order.is_test),
      message: `【LT 綠界測試付款】\n訂單：${order.order_no}\n金額：NT$ ${Number(order.total_amount).toLocaleString("zh-TW")}\n狀態：${order.payment_status}\n環境：測試`
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Notification center rejected the request with ${response.status}.`);
  return { sent: true };
}

module.exports = { sendPaymentNotification };
