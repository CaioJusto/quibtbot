# Billing (operator)

This documents the Stripe path behind `QUIBT_EDITION=cloud`. It is **not** a public product. Open-source installs keep billing off — see [editions.md](./editions.md). Public site: [quibt.com.br](https://quibt.com.br).

Cloud onboarding has a plan step, then three model sources: tokens Quibt sells,
an OpenRouter key, or a ChatGPT / Copilot / SuperGrok subscription. A key or
subscription does not eat the Quibt quota. There is no machine picker — Quibt
manages the computer.

Billing is disabled by default, so Open Source installs remain unlimited. A Cloud
deployment enables it with all of the following settings:

```env
QUIBT_EDITION=cloud
BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...
```

The API fails startup when billing is enabled and any setting is missing. The
worker needs `BILLING_ENABLED=true` so scheduled routines and automatic sandbox
boots enforce the same subscription, token, and computer-time policy as API
requests.

Configure Stripe to send these events to `POST {API}/billing/webhook`:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Webhook processing is idempotent by Stripe event ID and retrieves the current
subscription before changing local state, because [Stripe does not guarantee
event delivery order](https://docs.stripe.com/webhooks#event-ordering). Checkout
creation is serialized per workspace; customers with an existing subscription
are sent to the billing portal for plan changes.

The pricing page is `apps/www` `/pricing` (Portuguese, `noindex`, and not linked
from the public landing). After sign-up,
onboarding designs the bot character and can open Stripe Checkout for Starter or
Pro.
Signed-in billing lives at `/billing`. Success and cancel return to
`/billing?billing=success` and `/billing?billing=canceled`.

List prices in product copy: Trial free for 7 days, Starter $29/month, Pro
$79/month. Stripe Price ids still decide the charged amount.

Before production, run a Stripe test-mode checkout/webhook smoke test and a Box
smoke test with the deployment's real credentials. Neither live provider can be
validated by the default test suite without those external keys.

## Running Cloud

Same durable-process rules as [self-host.md](./self-host.md) (API + worker +
Postgres, not Vercel serverless). Differences:

- `QUIBT_EDITION=cloud` and `BILLING_ENABLED=true` with every Stripe setting.
- Set `SANDBOX_PROVIDER` yourself: Cloud boots only on `e2b` or `box`. Docker is
  refused because every workspace would share one host kernel and one Docker
  socket; a single-tenant "cloud" can opt out loudly with
  `QUIBT_ALLOW_SHARED_DOCKER=true`. The API and the worker both check this at
  startup. Users never see that choice.
- Landing `/pricing` CTAs open `/sign-up`. After sign-up, onboarding sells the
  plan, then the model source.

Startup refuses Cloud without billing, and refuses Open Source with billing on.
