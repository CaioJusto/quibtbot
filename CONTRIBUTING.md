# Contributing

This repository is **Quibt Bot**: an open-source, local-first product. There is
no hosted edition on the public site, README, or onboarding. Follow the README
“Run locally” path. Desktop: `pnpm desktop` or `pnpm dev:desktop` after the
stack is up — see [docs/desktop.md](docs/desktop.md).

## Setup

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm verify:fast
```

`pnpm verify:fast` uses emulators so it never calls live models or Composio.

## Product rules

- The public product is open source: model = OpenRouter key **or** subscription. The owner may pick Docker / E2B / Box.
- Do not add Cloud waitlists, dual-edition marketing, or a hosted CTA to README, `apps/www`, or onboarding copy.
- Keep `BILLING_ENABLED=false` in `.env.example` and self-host docs.
- Billing and `QUIBT_EDITION` still exist in the API for operators. Do not delete that engine in a drive-by change; also do not offer it in UX.

## Docs

If you change onboarding, sandbox choice, or the desktop app, update:

- `README.md`
- `docs/self-host.md`
- `docs/onboarding.md` and `docs/computers.md` (plain-language machine guides)
- `packages/core/src/machine-onboarding.ts` (the text the app shows after a machine is picked)
- `CLAUDE.md` when the product purpose or computer model changes
- `docs/desktop.md` when the Mac / Windows / Linux installers or local-first path change

## License

Apache-2.0. See `LICENSE` and `NOTICE` for third-party attribution required by the license.
