const DEFAULT_TIMEOUT_MS = 10000;

function activationEmailConfig(environment = process.env) {
  const apiKey = String(environment.RESEND_API_KEY || "").trim();
  const from = String(environment.ACTIVATION_EMAIL_FROM || "").trim();
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(String(environment.APP_BASE_URL || "").trim());
  } catch {
    parsedBaseUrl = null;
  }
  const localDevelopment = parsedBaseUrl && ["localhost", "127.0.0.1"].includes(parsedBaseUrl.hostname);
  if (!apiKey || !from || !parsedBaseUrl || (parsedBaseUrl.protocol !== "https:" && !localDevelopment)) {
    throw new Error("Activation Email is not configured.");
  }
  return { apiKey, from, baseUrl: parsedBaseUrl.origin };
}

function activationUrl(baseUrl, token) {
  const url = new URL("/member/activate", `${baseUrl}/`);
  url.searchParams.set("token", String(token || ""));
  return url.toString();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sendActivationEmail({
  to,
  name,
  token,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (typeof fetchImpl !== "function") throw new Error("Email transport is unavailable.");
  const config = activationEmailConfig(environment);
  const url = activationUrl(config.baseUrl, token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.from,
        to: [String(to || "").trim()],
        subject: "請啟用您的 LT 大健康成交平台會員帳號",
        html: `<p>${escapeHtml(name)}您好：</p>
          <p>請點擊下方連結設定密碼並啟用會員帳號：</p>
          <p><a href="${escapeHtml(url)}">啟用會員帳號</a></p>
          <p>此連結 24 小時內有效，且只能使用一次。若您未申請此帳號，可忽略本信。</p>`
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Activation Email provider rejected the request (${response.status}).`);
  }
  const result = await response.json();
  if (!result?.id) throw new Error("Activation Email provider returned an invalid response.");
  return { id: result.id };
}

module.exports = {
  activationEmailConfig,
  activationUrl,
  sendActivationEmail
};
