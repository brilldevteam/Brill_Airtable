# Brill Tables → SaaS plan

How to turn the in-house app into a product other companies sign up for and pay for monthly. No Docker anywhere: every piece below runs as plain Node, or as a managed service.

## Where we start

The app is already **multi-tenant at its core**. Every base belongs to a workspace, and every API route checks the caller's role in that workspace. The groundwork is also done (this round):

- hashed sessions with idle and absolute expiry
- brute-force limits
- password rules
- account settings
- security headers
- a database health check
- request IDs
- indexes
- an error screen
- configurable host and proxy settings

What's missing is what a business needs to **sell, run and scale** it.

## Target architecture (modern, serverless-friendly, no containers)

```
                 brilltables.com (marketing + pricing)      app.brilltables.com (React SPA)
                        │  static, on a CDN (Cloudflare Pages / Vercel)  │
                        └───────────────┬────────────────────────────────┘
                                        ▼
                         api.brilltables.com — Node 22 + Fastify (compiled JS)
                         2+ instances on Render / Railway (native Node build, no Dockerfile)
                         │            │              │                │
                 Postgres (Neon or    Object storage   Redis (Upstash) —    Email (Resend /
                 Supabase) — pooled,  (Cloudflare R2   realtime fan-out,    Postmark) — verify,
                 point-in-time        / S3) — files,   rate limits, job     reset, invites,
                 backups              signed URLs      queue                receipts
                                        │
                     Billing: Stripe or Razorpay (subscriptions + webhooks)
                     Monitoring: Sentry (errors), OpenTelemetry logs/metrics, uptime checks
```

**Tenancy model:** shared database, shared schema, with every row scoped by `workspace_id`. The workspace is the customer, and it holds the subscription, the members and the limits. This is how Airtable, Notion and Linear work: the cheapest to run, simple to back up, and fast to onboard. Postgres Row-Level Security can be added as a second safety net later.

## Phases

### S1 — Production-ready core (no new features)
1. **Postgres adapter.** Add a `pg` pool behind the existing `Db` interface, chosen by `DATABASE_URL`, with PGlite kept for development and tests. Run the test suite against both. Use a real migration runner (not split on `;`).
2. **File storage adapter.** Add S3-compatible storage (R2) next to local disk, chosen by environment variables. Serve files with short-lived signed URLs, and clean up files when a base or table is deleted.
3. **Shared state in Redis.** Move the live-update bus and the rate limiters to Redis so that several API instances work together.
4. **Production build.** Compile the API to JS, build the web app to static files, set the `PUBLIC_URL` / `APP_URL` configuration, validate settings at start-up, and run CI on GitHub Actions (typecheck, tests and build on every push).
5. **Paging.** Load records page by page, stream CSV exports, and cap rows on shared views.

### S2 — Accounts like a real product
1. ✅ **Email (done).** Confirm the address at sign-up, password reset (single-use hashed tokens, 1-hour expiry), every invite emailed and accepted (never auto-added), same response whether or not an email exists. Dev outbox at `/dev/mail`; Resend in production.
2. **Google sign-in** (OAuth), then **two-factor sign-in** (TOTP with recovery codes).
3. **Profile and settings:** avatar, time zone, notification settings, and account deletion with a data export.

### S3 — Billing and plans
| Plan | Price (example) | Limits |
|---|---|---|
| Free | ₹0 | 5 bases, 1,000 records per base, 1 GB files, 5 editors, 100 automation runs/month |
| Pro | ₹600 / editor / month | 50,000 records per base, 20 GB per editor, unlimited bases, 25,000 runs |
| Business | ₹1,200 / editor / month | 250,000 records per base, admin panel, audit log, SSO, priority support |

- `plans`, `subscriptions` and `usage` tables, with limits checked in the same places that create records, upload files or add members.
- Checkout, the customer billing portal, invoices with GST, a **14-day Pro trial**, and dunning emails for failed payments. All are driven by provider **webhooks** (signed, idempotent).
- Seat counting: owners, creators and editors are paid seats; commenters and read-only members are free (the Airtable model).

### S4 — Growth surfaces
1. **Marketing site:** landing page, pricing, templates gallery, docs, changelog, legal pages (Terms, Privacy, DPA), and cookie consent.
2. **Onboarding:** a "Start from a template" picker (built from the demo loader: CRM, project tracker, content calendar, inventory), an empty-state checklist, and product tours.
3. **Templates and Airtable import:** an "Import from Airtable" tool built on the batch API, so customers can switch in minutes.

### S5 — Features that justify the price
Automations (trigger → actions: email, webhook, update record, Slack/WhatsApp), interfaces/dashboards (charts, numbers, lists), group-by, trash and restore, undo, record templates, a public REST API with personal access tokens, and outgoing webhooks.

### S6 — Run it as a business
- **Super-admin console:** tenants, plans, usage, suspending accounts, and impersonation with an audit trail.
- **Workspace audit log** (Business plan).
- **Observability:** Sentry, request tracing, alerts, a status page.
- **Data protection:** nightly backup tests and point-in-time recovery, plus compliance with India's DPDP Act and GDPR (data export, deletion, records of processing). SOC 2 readiness later.

## Order and effort (rough)

| Phase | Effort |
|---|---|
| S1 | 1–2 weeks |
| S2 | 1 week |
| S3 | 1–2 weeks |
| S4 | 1–2 weeks |
| S5 | ongoing |
| S6 | alongside S3–S5 |

S1 to S3 together are the **minimum sellable product**.

## Decisions needed from Brill

1. **Payments** (postponed — S3 is skipped for now): **Razorpay** (best for India: UPI, cards, GST invoices, INR) or **Stripe** (best for international customers). Both can be added later; pick the first.
2. **Hosting:** recommended setup is Render (API) + Neon (Postgres) + Cloudflare R2 (files) + Cloudflare Pages (web) + Resend (email). All are managed, all run without Docker, and all have free or cheap tiers to start.
3. **Product name and domain** for the public launch, and the final prices.
