require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";
const CHAR_PER_MINUTE = Number(process.env.CHAR_PER_MINUTE || 900);
const FREE_MINUTES = Number(process.env.FREE_MINUTES || 5);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SUCCESS_URL =
  process.env.STRIPE_SUCCESS_URL ||
  "https://pdftext2speech.com/success?session_id={CHECKOUT_SESSION_ID}";
const STRIPE_CANCEL_URL =
  process.env.STRIPE_CANCEL_URL || "https://pdftext2speech.com/pricing";
const BILLING_PORTAL_RETURN_URL =
  process.env.BILLING_PORTAL_RETURN_URL || "https://pdftext2speech.com/account";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const PRICE_CONFIG = {
  monthly: {
    priceId: process.env.STRIPE_PRICE_MONTHLY,
    minutes: Number(process.env.MONTHLY_MINUTES || 360),
    mode: "subscription",
    plan: "monthly",
  },
  annual: {
    priceId: process.env.STRIPE_PRICE_ANNUAL,
    minutes: Number(process.env.ANNUAL_MINUTES || 4320),
    mode: "subscription",
    plan: "annual",
  },
  addon_3h: {
    priceId: process.env.STRIPE_PRICE_ADDON_3H,
    minutes: Number(process.env.ADDON_3H_MINUTES || 180),
    mode: "payment",
    plan: "addon_3h",
  },
  addon_5h: {
    priceId: process.env.STRIPE_PRICE_ADDON_5H,
    minutes: Number(process.env.ADDON_5H_MINUTES || 300),
    mode: "payment",
    plan: "addon_5h",
  },
  addon_10h: {
    priceId: process.env.STRIPE_PRICE_ADDON_10H,
    minutes: Number(process.env.ADDON_10H_MINUTES || 600),
    mode: "payment",
    plan: "addon_10h",
  },
  addon_20h: {
    priceId: process.env.STRIPE_PRICE_ADDON_20H,
    minutes: Number(process.env.ADDON_20H_MINUTES || 1200),
    mode: "payment",
    plan: "addon_20h",
  },
};

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "data", "tts.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    device_token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    minutes_left INTEGER NOT NULL DEFAULT 0,
    has_paid INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT,
    plan TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
`);

const jsonParser = express.json({ limit: "1mb" });

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "x-device-token"],
  })
);

app.use((req, res, next) => {
  if (req.originalUrl === "/stripe/webhook") {
    next();
    return;
  }
  jsonParser(req, res, next);
});

const nowIso = () => new Date().toISOString();

function getDeviceToken(req) {
  return (
    req.get("x-device-token") ||
    req.query.device_token ||
    req.body?.device_token ||
    null
  );
}

function getUser(deviceToken) {
  return db
    .prepare("SELECT * FROM users WHERE device_token = ?")
    .get(deviceToken);
}

function getUserByCustomer(customerId) {
  return db
    .prepare("SELECT * FROM users WHERE stripe_customer_id = ?")
    .get(customerId);
}

function createUser(deviceToken) {
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO users
      (device_token, created_at, updated_at, minutes_left, has_paid)
     VALUES (?, ?, ?, ?, ?)`
  ).run(deviceToken, createdAt, createdAt, FREE_MINUTES, 0);
  return getUser(deviceToken);
}

function getOrCreateUser(deviceToken) {
  const existing = getUser(deviceToken);
  if (existing) {
    return existing;
  }
  return createUser(deviceToken);
}

function updateUser(deviceToken, fields) {
  const sets = [];
  const values = [];
  Object.entries(fields).forEach(([key, value]) => {
    sets.push(`${key} = ?`);
    values.push(value);
  });
  values.push(nowIso());
  values.push(deviceToken);
  db.prepare(
    `UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE device_token = ?`
  ).run(...values);
}

function addMinutes(deviceToken, minutes) {
  db.prepare(
    `UPDATE users SET minutes_left = minutes_left + ?, updated_at = ?
     WHERE device_token = ?`
  ).run(minutes, nowIso(), deviceToken);
}

function deductMinutes(deviceToken, minutes) {
  db.prepare(
    `UPDATE users SET minutes_left = minutes_left - ?, updated_at = ?
     WHERE device_token = ?`
  ).run(minutes, nowIso(), deviceToken);
}

function markPaid(deviceToken) {
  db.prepare(
    `UPDATE users SET has_paid = 1, updated_at = ? WHERE device_token = ?`
  ).run(nowIso(), deviceToken);
}

function hasProcessedEvent(eventId) {
  return Boolean(
    db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eventId)
  );
}

function markEventProcessed(eventId) {
  db.prepare("INSERT INTO events (event_id, created_at) VALUES (?, ?)").run(
    eventId,
    nowIso()
  );
}

function getPlanByPriceId(priceId) {
  return Object.values(PRICE_CONFIG).find((plan) => plan.priceId === priceId);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    openai: Boolean(OPENAI_API_KEY),
    stripe: Boolean(STRIPE_SECRET_KEY),
  });
});

app.get("/me", (req, res) => {
  const deviceToken = getDeviceToken(req);
  if (!deviceToken) {
    res.status(400).json({ error: "Missing device token" });
    return;
  }
  const user = getOrCreateUser(deviceToken);
  res.json({
    minutesLeft: user.minutes_left,
    paid: Boolean(user.has_paid || user.subscription_status === "active"),
    subscriptionStatus: user.subscription_status || "none",
    plan: user.plan || null,
    portalAvailable: Boolean(user.stripe_customer_id),
  });
});

app.post("/checkout", async (req, res) => {
  if (!stripe) {
    res.status(503).json({ error: "Stripe not configured" });
    return;
  }
  const deviceToken = getDeviceToken(req);
  const planKey = req.body?.plan;
  if (!deviceToken || !planKey) {
    res.status(400).json({ error: "Missing device token or plan" });
    return;
  }
  const plan = PRICE_CONFIG[planKey];
  if (!plan?.priceId) {
    res.status(400).json({ error: "Unknown plan" });
    return;
  }

  const user = getOrCreateUser(deviceToken);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      client_reference_id: deviceToken,
      metadata: {
        device_token: deviceToken,
        plan: plan.plan,
      },
      subscription_data:
        plan.mode === "subscription"
          ? {
              metadata: {
                device_token: deviceToken,
                plan: plan.plan,
              },
            }
          : undefined,
      customer: user.stripe_customer_id || undefined,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: "Unable to create checkout session" });
  }
});

app.post("/portal", async (req, res) => {
  if (!stripe) {
    res.status(503).json({ error: "Stripe not configured" });
    return;
  }
  const deviceToken = getDeviceToken(req);
  if (!deviceToken) {
    res.status(400).json({ error: "Missing device token" });
    return;
  }
  const user = getUser(deviceToken);
  if (!user?.stripe_customer_id) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: BILLING_PORTAL_RETURN_URL,
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: "Unable to create portal session" });
  }
});

app.post("/tts", async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    return;
  }

  const deviceToken = getDeviceToken(req);
  if (!deviceToken) {
    res.status(400).json({ error: "Missing device token" });
    return;
  }

  const { text, input, speed, voice } = req.body || {};
  const payloadInput =
    typeof input === "string" && input.trim().length
      ? input
      : typeof text === "string"
      ? text
      : "";
  if (!payloadInput) {
    res.status(400).json({ error: "Missing input" });
    return;
  }
  if (payloadInput.length > 4000) {
    res.status(400).json({ error: "Text too long" });
    return;
  }

  const user = getOrCreateUser(deviceToken);
  const cost = Math.max(1, Math.ceil(payloadInput.length / CHAR_PER_MINUTE));
  if (user.minutes_left < cost) {
    res.status(402).json({ error: "not-enough-queries" });
    return;
  }

  deductMinutes(deviceToken, cost);

  const payload = {
    model: OPENAI_TTS_MODEL,
    input: payloadInput,
    voice: voice || OPENAI_TTS_VOICE,
    response_format: "mp3",
  };

  if (typeof speed === "number" && Number.isFinite(speed)) {
    payload.speed = Math.min(Math.max(speed, 0.5), 2.0);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      addMinutes(deviceToken, cost);
      res.status(response.status).send(errorText);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) {
    addMinutes(deviceToken, cost);
    res.status(500).json({ error: "TTS request failed" });
  }
});

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      res.status(500).json({ error: "Stripe webhook not configured" });
      return;
    }
    const signature = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      res.status(400).send(`Webhook Error: ${error.message}`);
      return;
    }

    if (hasProcessedEvent(event.id)) {
      res.json({ received: true });
      return;
    }
    markEventProcessed(event.id);

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const deviceToken =
          session.client_reference_id || session.metadata?.device_token;
        const planKey = session.metadata?.plan;
        const plan = PRICE_CONFIG[planKey];
        if (deviceToken && plan) {
          getOrCreateUser(deviceToken);
          if (session.customer) {
            updateUser(deviceToken, { stripe_customer_id: session.customer });
          }
          markPaid(deviceToken);
          if (session.mode === "subscription") {
            updateUser(deviceToken, {
              stripe_subscription_id: session.subscription || null,
              subscription_status: "active",
              plan: plan.plan,
            });
            addMinutes(deviceToken, plan.minutes);
          }
          if (session.mode === "payment") {
            addMinutes(deviceToken, plan.minutes);
          }
        }
      }

      if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        if (invoice.billing_reason === "subscription_cycle") {
          const customerId = invoice.customer;
          const line = invoice.lines?.data?.[0];
          const priceId = line?.price?.id;
          const plan = getPlanByPriceId(priceId);
          const user = customerId ? getUserByCustomer(customerId) : null;
          if (user && plan) {
            updateUser(user.device_token, {
              subscription_status: "active",
              plan: plan.plan,
            });
            addMinutes(user.device_token, plan.minutes);
          }
        }
      }

      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const plan = getPlanByPriceId(priceId);
        const user = customerId ? getUserByCustomer(customerId) : null;
        if (user) {
          updateUser(user.device_token, {
            stripe_subscription_id: subscription.id,
            subscription_status: subscription.status,
            plan: plan?.plan || user.plan,
          });
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const user = customerId ? getUserByCustomer(customerId) : null;
        if (user) {
          updateUser(user.device_token, {
            stripe_subscription_id: subscription.id,
            subscription_status: "canceled",
          });
        }
      }
    } catch (error) {
      res.status(500).json({ error: "Webhook processing failed" });
      return;
    }

    res.json({ received: true });
  }
);

app.listen(PORT, () => {
  console.log(`AI TTS server listening on http://localhost:${PORT}`);
});
