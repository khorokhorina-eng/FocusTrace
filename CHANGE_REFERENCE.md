# FocusTrace Change Reference

This file is the current working reference for the extension, the publish bundle, and the matching backend behavior.

## Source Of Truth

- Extension repo: [FocusTrace](/Users/n.khorokhorina/Self/FocusTrace)
- Production domain: `https://pdftext2speech.com`
- Privacy policy: `https://pdftext2speech.com/privacy`
- Support email: `support@pdftext2speech.com`
- Current backend code in this repo: [server.js](/Users/n.khorokhorina/Self/FocusTrace/server.js)

## Current Product Behavior

- Users get `5` free minutes without registration.
- TTS requests are sent to `https://pdftext2speech.com/tts`.
- Google sign-in is the only auth flow.
- Checkout requires sign-in before Stripe.
- Paid quotas are enforced server-side:
  - monthly: `300` minutes per billing period
  - annual: `3600` minutes (`60` hours) per billing period

## Current API Contract

- `GET /health`
- `GET /me`
- `GET /auth/me`
- `GET /auth/google/start`
- `GET /auth/google/callback`
- `POST /auth/logout`
- `POST /tts`
- `POST /checkout`
- `POST /stripe/checkout-session`
- `GET /stripe/subscription-status`
- `POST /stripe/webhook`

The extension must send the device token with backend requests:

- header: `x-device-token`

## Current Extension Notes

- Main runtime files:
  - [manifest.json](/Users/n.khorokhorina/Self/FocusTrace/manifest.json)
  - [background.js](/Users/n.khorokhorina/Self/FocusTrace/background.js)
  - [popup.html](/Users/n.khorokhorina/Self/FocusTrace/popup.html)
  - [popup.js](/Users/n.khorokhorina/Self/FocusTrace/popup.js)
  - [paywall.html](/Users/n.khorokhorina/Self/FocusTrace/paywall.html)
  - [paywall.js](/Users/n.khorokhorina/Self/FocusTrace/paywall.js)
- Paywall copy must not say `Unlimited listening` or `Unlimited playback`.
- After successful sign-in, the Google CTA and pre-checkout auth prompt should be hidden; only the signed-in state remains visible.
- The popup and paywall must stay aligned with the backend quota model.

## Current Backend Notes

- Required env:
  - `OPENAI_API_KEY`
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `PUBLIC_BASE_URL`
- Supported Stripe price env names:
  - `STRIPE_PRICE_MONTHLY` or `STRIPE_MONTHLY_PRICE_ID`
  - `STRIPE_PRICE_ANNUAL` or `STRIPE_YEARLY_PRICE_ID`
- Google OAuth env:
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
- Optional quota env:
  - `FREE_MINUTES` default `5`
  - `CHAR_PER_MINUTE` default `900`
  - `MONTHLY_MINUTES` default `300`
  - `ANNUAL_MINUTES` default `3600`

## Static Site Notes

- Static site source: [site](/Users/n.khorokhorina/Self/FocusTrace/site)
- Important public pages:
  - `/`
  - `/pricing`
  - `/support`
  - `/privacy`

## Chrome Web Store Notes

- Keep `storage` permission.
- Keep host permissions only for:
  - browser-opened PDFs
  - local PDFs
  - `pdftext2speech.com`
- Do not reintroduce `activeTab` unless the implementation truly needs it.
- The extension does not use remote code execution.

## Publish Bundle

- Build a clean zip from the contents of [FocusTrace](/Users/n.khorokhorina/Self/FocusTrace), not from the parent folder.
- Exclude:
  - `server.js`
  - `package.json`
  - `package-lock.json`
  - `.env`
  - `.env.example`
  - `site/`
  - `PUBLISHING_COPY.md`
  - `.gitignore`
  - scratch files such as `ai-server-live.js`
- Keep the required packaged `pdfjs` assets referenced by the manifest and popup:
  - `node_modules/pdfjs-dist/build/pdf.min.js`
  - `node_modules/pdfjs-dist/build/pdf.worker.min.js`
- Current bundle name:
  - `/Users/n.khorokhorina/Self/FocusTrace-chrome-web-store-final.zip`

## Template Workflow

- Template guide: [TEMPLATE_GUIDE.md](/Users/n.khorokhorina/Self/FocusTrace/TEMPLATE_GUIDE.md)
- New product checklist: [NEW_PRODUCT_CHECKLIST.md](/Users/n.khorokhorina/Self/FocusTrace/NEW_PRODUCT_CHECKLIST.md)
- Local copy helper:
  - [create_product_copy.sh](/Users/n.khorokhorina/Self/FocusTrace/scripts/create_product_copy.sh)

## Before Shipping Changes

1. Reload the unpacked extension in `chrome://extensions/`.
2. Test a browser PDF.
3. Test a local PDF.
4. Test free-trial depletion on a fresh device token.
5. Test Google sign-in.
6. Test Stripe checkout gating after sign-in.
7. Re-check `https://pdftext2speech.com/privacy` if data flow text changed.
