# Quibt editions (operator)

The public product is **open source / local-first**. This page documents the `QUIBT_EDITION` flag that still exists in the API and worker. Cloud is not offered on [quibt.com.br](https://quibt.com.br), the README, or onboarding.

One repository. The hosted path is an operator flag, not a second git branch.

| | **Quibt Open Source** | **Quibt Cloud** |
| --- | --- | --- |
| Who runs it | You, on your machine or VPS | Quibt |
| How you pay for models | Your OpenRouter key, a local Ollama / OpenAI-compatible URL, **or** your ChatGPT / Copilot / SuperGrok subscription | Those two **plus** tokens Quibt sells |
| Computer | You pick from the catalog: Docker here, your VPS / remote supervisor, E2B, Box, or Daytona (BYOK) | Quibt manages it. No machine picker |
| Billing | Off. Unlimited bots on that deploy | Stripe. Trial / Starter / Pro |
| Flag | `QUIBT_EDITION=oss` (default) | `QUIBT_EDITION=cloud` + `BILLING_ENABLED=true` |

The same application boots both ways. A separate `open-source` branch would fork every fix. Edition is an env flag, not a fork.

## Onboarding

**Open Source**

1. Sign up. There is no plan step.
2. Choose a model source: paste an OpenRouter key, point at a local Ollama / LM Studio URL, or sign in with a subscription.
3. If you own the deploy, pick the computer from the catalog (Docker, remote supervisor / VPS, E2B, Box, or Daytona). Keys and the supervisor URL can be pasted in the UI.
4. Design the first bot.

**Cloud**

1. Sign up and pick a plan (Trial / Starter / Pro).
2. Choose a model source: tokens Quibt sells, an OpenRouter key, or a subscription. A key or subscription does not eat the Quibt quota.
3. No machine step. The computer is managed.
4. Design the first bot.

## Open Source

Default. `BILLING_ENABLED` stays false.

Changing the computer after first boot: pick the new machine in the deployment screen. The choice
is stored in `deployment_settings.sandboxProvider` and both the API and the worker route to it, so
no restart and no `.env` edit are needed. Two rules make that safe:

- A computer that is already running stays on the provider that created it. The new machine takes
  effect the next time that computer boots, and the old sandbox is stopped before the new one
  starts, so nothing is left running on the provider you left behind.
- `SANDBOX_PROVIDER` is the fallback: it is used when nothing is saved or when the edition does not
  allow a choice. E2B, Box, Daytona, and a remote supervisor accept keys and endpoints in **Settings → Máquina**
  (BYOK), not only in `.env`.

See [self-host.md](./self-host.md).

## Cloud

Hosted SaaS. Requires Stripe. Users cannot choose the sandbox provider. Startup refuses `QUIBT_EDITION=cloud` without billing, and refuses `QUIBT_EDITION=oss` with billing on.

Cloud also refuses to boot on Docker. Docker is the trusted single-machine implementation: every
workspace would share one host kernel and one Docker socket, which is exactly what
[self-host.md](./self-host.md) tells public multi-user deployments not to do. Cloud must run on
`SANDBOX_PROVIDER=e2b`, `box`, or `daytona`. If you host "cloud" only for yourself on one box, say so out loud
with `QUIBT_ALLOW_SHARED_DOCKER=true`. The API and the worker both apply this check at startup.

See [saas-billing.md](./saas-billing.md).

## Docs in this repo

| File | Audience |
| --- | --- |
| [../README.md](../README.md) | First run (Open Source locally) |
| [onboarding.md](./onboarding.md) | First run in plain language |
| [computers.md](./computers.md) | Docker, VPS, E2B, Box, Daytona — what the owner must do |
| [self-host.md](./self-host.md) | Operator hosting Open Source |
| [saas-billing.md](./saas-billing.md) | Operator running Cloud |
| [../CLAUDE.md](../CLAUDE.md) | Purpose and computer model for agents |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reports |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | People changing this repo |

## Public product

The website, README, and onboarding present only the open-source path. The Cloud flag stays in the API for operators; it is not a download or landing CTA.
