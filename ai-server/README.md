# PDF Text to Speech API (TTS + billing)

This server keeps your OpenAI API key off the client, serves TTS audio, and
tracks user minutes plus Stripe subscriptions/add-ons.

## 1) Install

```bash
cd ai-server
npm install
```

## 2) Configure

Create a `.env` file:

```
OPENAI_API_KEY=your_openai_api_key
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=alloy
PORT=8787

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_MONTHLY=price_monthly_id
STRIPE_PRICE_ANNUAL=price_annual_id
STRIPE_PRICE_ADDON_3H=price_addon_3h
STRIPE_PRICE_ADDON_5H=price_addon_5h
STRIPE_PRICE_ADDON_10H=price_addon_10h
STRIPE_PRICE_ADDON_20H=price_addon_20h

# Optional
STRIPE_SUCCESS_URL=https://pdftext2speech.com/success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=https://pdftext2speech.com/pricing
BILLING_PORTAL_RETURN_URL=https://pdftext2speech.com/account
FREE_MINUTES=5
CHAR_PER_MINUTE=900
DB_PATH=./data/tts.db
ENABLE_DEV_ENDPOINTS=true

# Support email (SMTP)
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=hello@pdftext2speech.com
SMTP_PASS=your_password
SMTP_SECURE=false
SUPPORT_EMAIL_TO=hello@pdftext2speech.com
SUPPORT_EMAIL_FROM=hello@pdftext2speech.com
```

The server loads `.env` automatically.

## 3) Run

```bash
npm start
```

The server will listen on:

```
http://localhost:8787/tts
```

## 4) Update the extension

Edit `config.js` in the extension root:

```js
window.PDF_TTS_CONFIG = {
  apiBaseUrl: "http://localhost:8787",
  // Optional: override the TTS endpoint directly.
  aiEndpoint: "",
  aiEnabledByDefault: true,
  aiDefaultVoice: "alloy",
};
```

Then reload the extension in `chrome://extensions`.

## API Endpoints

- `GET /health` - health check
- `GET /me` - returns minutes + subscription status
- `POST /checkout` - creates Stripe Checkout session
- `POST /portal` - creates Stripe Customer Portal session
- `POST /support` - sends support email
- `POST /tts` - returns `audio/mpeg` (deducts minutes)
- `POST /stripe/webhook` - Stripe webhooks
- `POST /dev/reset-trial` - reset current device to test minutes (dev only)

## Notes

- `/tts` expects JSON: `{ text, speed, voice }`
- Pass `x-device-token` header from the extension
- The server deducts minutes by character length (default 900 chars/minute)
- Use HTTPS in production
