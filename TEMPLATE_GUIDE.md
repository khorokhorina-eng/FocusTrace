# FocusTrace Template Guide

This project is both:

- the live codebase for `PDF Text to Speech`
- the template source for future paid Chrome extensions with the same structure

The goal is to keep this product working while also reusing the same architecture for new products.

## What Should Be Reused

Reuse these parts for a new extension:

- Google sign-in flow
- device token handling
- free trial handling
- paid quota handling
- Stripe checkout gating
- welcome page structure
- popup/paywall structure
- static site structure
- `CHANGE_REFERENCE.md` workflow

## What Must Change Per Product

Each new product should have its own:

- product name
- extension description
- domain
- support email
- Stripe products and price IDs
- trial rules
- paid plan limits
- site copy
- welcome copy
- icons and screenshots
- feature-specific extension logic

## Recommended Repo Strategy

Use one GitHub repository per product.

Suggested workflow:

1. Keep this repository as the working template source.
2. Create a new local copy for the next product.
3. Create a new GitHub repository for that product.
4. Push the new product there.
5. Maintain each product separately after that.

This avoids mixing branding, Stripe config, domains, and deployments between products.

## Recommended Server Strategy

You do not need a new physical server for every product.

A practical setup is:

- one Hetzner server
- one backend process per product
- one domain per product
- one nginx site config per product
- one `.env` per product
- one Stripe product/pricing setup per product

Example:

- `/root/product-a`
- `/root/product-b`

with separate ports and nginx routing.

## Local Copy Workflow

Use the helper script:

```bash
/Users/n.khorokhorina/Self/FocusTrace/scripts/create_product_copy.sh /Users/n.khorokhorina/Self/NewProduct
```

That creates a clean copy of the template without:

- `.git`
- `.env`
- scratch investigation files
- generated zip bundles

## After Copying The Template

Open the new project and update:

- `manifest.json`
- `popup.html`
- `popup.js`
- `paywall.html`
- `paywall.js`
- `welcome.html`
- `site/*`
- `PUBLISHING_COPY.md`
- `CHANGE_REFERENCE.md`
- `server.js`
- `.env.example`

Then create a new Git repo in the copied folder:

```bash
cd /path/to/new-product
git init
git add .
git commit -m "Initial product scaffold"
```

Then connect it to a new GitHub repository.
