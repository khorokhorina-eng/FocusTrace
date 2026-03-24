# New Product Checklist

Use this after copying the template into a new project folder.

## Identity

- Replace product name everywhere.
- Replace extension description.
- Replace support email.
- Replace domain name.
- Replace privacy policy URL.

## Extension

- Update [manifest.json](/Users/n.khorokhorina/Self/FocusTrace/manifest.json)
- Update popup copy and UI
- Update paywall copy and UI
- Update welcome page title and text
- Replace icons
- Replace screenshots and store assets

## Backend

- Set new `PUBLIC_BASE_URL`
- Set new `GOOGLE_OAUTH_CLIENT_ID`
- Set new `GOOGLE_OAUTH_CLIENT_SECRET`
- Set new Stripe price IDs
- Set product-specific `FREE_MINUTES`
- Set product-specific `MONTHLY_MINUTES`
- Set product-specific `ANNUAL_MINUTES`
- Review any feature-specific endpoints

## Website

- Replace site text in `site/`
- Replace product images
- Update pricing page text to match the new product
- Update support page
- Update privacy policy copy if data flow is different

## Stripe

- Create separate Stripe products for the new extension
- Create separate monthly and annual prices
- Update webhook configuration if needed
- Confirm checkout success/cancel URLs use the new domain

## Google OAuth

- Create a new OAuth client if the new product has a different domain
- Set the redirect URI to:
  - `https://NEW_DOMAIN/auth/google/callback`

## Server / Deployment

- Create a separate backend directory on the server
- Create a separate `.env`
- Use a separate port
- Add a separate nginx config
- Add a separate process manager entry

## Review / Store

- Update `PUBLISHING_COPY.md`
- Update privacy disclosures
- Rebuild the clean Chrome Web Store zip
- Verify the paywall copy does not promise unlimited usage unless the backend actually allows it

## Final Verification

1. Install the unpacked extension
2. Test the core product feature
3. Test free trial depletion
4. Test Google sign-in
5. Test checkout gating
6. Test Stripe checkout
7. Test the public site
8. Test privacy policy URL
