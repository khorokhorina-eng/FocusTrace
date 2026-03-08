const http = require("http");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const STRIPE_MONTHLY_PRICE_ID = process.env.STRIPE_MONTHLY_PRICE_ID || "";
const STRIPE_YEARLY_PRICE_ID = process.env.STRIPE_YEARLY_PRICE_ID || "";

const PLAN_DEFINITIONS = [
  {
    id: "monthly",
    name: "Monthly plan",
    description: "Unlimited playback and full access.",
    priceLabel: "$9.99",
    period: "month",
    type: "paid",
    cta: "Upgrade",
    stripePriceId: STRIPE_MONTHLY_PRICE_ID,
  },
  {
    id: "yearly",
    name: "Yearly plan",
    description: "Unlimited playback and full access.",
    priceLabel: "$89.99",
    period: "year",
    type: "paid",
    cta: "Upgrade",
    stripePriceId: STRIPE_YEARLY_PRICE_ID,
  },
];

const STATE_PATH = path.join(__dirname, "stripe-state.json");

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Stripe-Signature");
}

function sendJson(res, status, payload) {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function ensureStripeConfigured(res) {
  if (stripe) {
    return true;
  }
  sendJson(res, 500, { error: "STRIPE_SECRET_KEY is not set." });
  return false;
}

function ensureStateFile() {
  if (!fs.existsSync(STATE_PATH)) {
    const initial = {
      installToCustomer: {},
      customerToInstall: {},
      sessionToInstall: {},
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(initial, null, 2));
  }
}

function readState() {
  ensureStateFile();
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      installToCustomer: parsed.installToCustomer || {},
      customerToInstall: parsed.customerToInstall || {},
      sessionToInstall: parsed.sessionToInstall || {},
    };
  } catch (_error) {
    return {
      installToCustomer: {},
      customerToInstall: {},
      sessionToInstall: {},
    };
  }
}

function writeState(nextState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > 2 * 1024 * 1024) {
        reject(new Error("Payload too large."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

async function parseJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer.length) {
    return {};
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (_error) {
    throw new Error("Invalid JSON payload.");
  }
}

function getPlanById(planId) {
  return PLAN_DEFINITIONS.find((plan) => plan.id === planId) || null;
}

function getPlanByStripePriceId(priceId) {
  return PLAN_DEFINITIONS.find(
    (plan) => plan.type === "paid" && plan.stripePriceId && plan.stripePriceId === priceId
  ) || null;
}

function sanitizeExtensionReturnUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "chrome-extension:") {
      return "";
    }
    if (!parsed.pathname.endsWith("/paywall.html")) {
      return "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

async function handleCreateCheckoutSession(req, res) {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
    return;
  }

  const installId = typeof body.installId === "string" ? body.installId.trim() : "";
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const returnUrl = sanitizeExtensionReturnUrl(body.returnUrl);

  if (!installId || !planId) {
    sendJson(res, 400, { error: "installId and planId are required." });
    return;
  }

  try {
    const selectedPlan = getPlanById(planId);
    if (!selectedPlan || selectedPlan.type !== "paid") {
      sendJson(res, 400, { error: "Unknown paid plan." });
      return;
    }

    if (!selectedPlan.stripePriceId) {
      sendJson(res, 500, {
        error: `Stripe price ID is not configured for the ${selectedPlan.id} plan.`,
      });
      return;
    }

    const state = readState();
    const existingCustomer = state.installToCustomer[installId] || undefined;
    const cancelUrl = returnUrl || `http://127.0.0.1:${PORT}/paywall/cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: selectedPlan.stripePriceId, quantity: 1 }],
      success_url: `http://127.0.0.1:${PORT}/paywall/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      client_reference_id: installId,
      metadata: { installId, planId: selectedPlan.id },
      ...(existingCustomer ? { customer: existingCustomer } : {}),
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { installId, planId: selectedPlan.id },
      },
    });

    state.sessionToInstall[session.id] = installId;
    writeState(state);

    sendJson(res, 200, { url: session.url, sessionId: session.id });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to create checkout session." });
  }
}

async function lookupSubscriptionStatus(installId) {
  const state = readState();
  const customerId = state.installToCustomer[installId];

  if (!customerId) {
    return {
      active: false,
      status: "none",
      plan: null,
      customerId: null,
      limitBypassed: false,
    };
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });

  const activeSub = subscriptions.data.find(
    (sub) => sub.status === "active" || sub.status === "trialing"
  );

  if (!activeSub) {
    return {
      active: false,
      status: subscriptions.data[0]?.status || "none",
      plan: null,
      customerId,
      limitBypassed: false,
    };
  }

  const firstItem = activeSub.items?.data?.[0];
  const price = firstItem?.price;
  const matchingPlan = getPlanByStripePriceId(price?.id || "");

  return {
    active: true,
    status: activeSub.status,
    customerId,
    limitBypassed: true,
    plan: {
      planId: matchingPlan?.id || activeSub.metadata?.planId || null,
      subscriptionId: activeSub.id,
      priceId: price?.id || null,
      interval: price?.recurring?.interval || null,
      intervalCount: price?.recurring?.interval_count || null,
      currentPeriodEnd: activeSub.current_period_end || null,
    },
  };
}

async function handleSubscriptionStatus(req, res, parsedUrl) {
  if (!ensureStripeConfigured(res)) {
    return;
  }

  const installId = parsedUrl.searchParams.get("installId") || "";
  if (!installId) {
    sendJson(res, 400, { error: "installId is required." });
    return;
  }

  try {
    const status = await lookupSubscriptionStatus(installId);
    sendJson(res, 200, { installId, ...status });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to read subscription status." });
  }
}

function rememberInstallCustomer(installId, customerId) {
  if (!installId || !customerId) {
    return;
  }
  const state = readState();
  state.installToCustomer[installId] = customerId;
  state.customerToInstall[customerId] = installId;
  writeState(state);
}

async function handleStripeWebhook(req, res) {
  if (!ensureStripeConfigured(res)) {
    return;
  }
  if (!STRIPE_WEBHOOK_SECRET) {
    sendJson(res, 500, { error: "STRIPE_WEBHOOK_SECRET is not set." });
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Unable to read webhook body." });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    sendJson(res, 400, { error: "Missing Stripe-Signature header." });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    sendJson(res, 400, { error: `Webhook signature verification failed: ${error.message}` });
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const installId =
        session.client_reference_id ||
        session.metadata?.installId ||
        readState().sessionToInstall?.[session.id] ||
        "";
      const customerId = typeof session.customer === "string" ? session.customer : "";
      rememberInstallCustomer(installId, customerId);
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : "";
      const installId = sub.metadata?.installId || readState().customerToInstall?.[customerId] || "";
      rememberInstallCustomer(installId, customerId);
    }

    sendJson(res, 200, { received: true });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Webhook handler failed." });
  }
}

async function handleTts(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: "OPENAI_API_KEY is not set.",
    });
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid request body." });
    return;
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const speed = Number(body.speed);

  if (!text) {
    sendJson(res, 400, { error: "Text is required." });
    return;
  }

  const payload = {
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    input: text,
    format: "mp3",
  };

  if (Number.isFinite(speed)) {
    payload.speed = Math.min(4, Math.max(0.25, speed));
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const details = await upstream.text().catch(() => "");
      sendJson(res, upstream.status, {
        error: details || "OpenAI TTS request failed.",
      });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    setCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch (error) {
    sendJson(res, 502, {
      error: error.message || "Failed to call OpenAI TTS.",
    });
  }
}

function handleSuccessPage(res) {
  sendHtml(
    res,
    200,
    `<!doctype html><html><head><meta charset="utf-8"><title>Payment successful</title><style>body{font-family:Arial,sans-serif;padding:32px;background:#f8fafc;color:#0f172a}a{color:#2563eb}</style></head><body><h1>Payment successful</h1><p>Your subscription is active. Return to the extension and click Read Aloud again.</p></body></html>`
  );
}

function handleCancelPage(res) {
  sendHtml(
    res,
    200,
    `<!doctype html><html><head><meta charset="utf-8"><title>Checkout canceled</title><style>body{font-family:Arial,sans-serif;padding:32px;background:#f8fafc;color:#0f172a}a{color:#2563eb}</style></head><body><h1>Checkout canceled</h1><p>No changes were made. You can return to the extension and try again anytime.</p></body></html>`
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "POST" && parsedUrl.pathname === "/tts") {
    await handleTts(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/stripe/checkout-session") {
    await handleCreateCheckoutSession(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/stripe/subscription-status") {
    await handleSubscriptionStatus(req, res, parsedUrl);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/stripe/webhook") {
    await handleStripeWebhook(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/paywall/success") {
    handleSuccessPage(res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/paywall/cancel") {
    handleCancelPage(res);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Proxy server is running on http://127.0.0.1:${PORT}`);
  console.log(
    "Required for Stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MONTHLY_PRICE_ID, STRIPE_YEARLY_PRICE_ID"
  );
});
