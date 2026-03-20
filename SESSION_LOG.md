# MPP Merchant Endpoint-as-a-Service: Session Log

**Date:** March 19-20, 2026
**Participants:** Cuy Sheffield (csmoove), JR (Research Analyst), ad (second agent)
**Channel:** Discord #mpp-endpoint-as-a-service

---

## How This Product Came Together

This document captures the full Discord session that led to the conception, PRD, documentation, and V1 build of MPP Merchant Endpoint-as-a-Service.

---

## Session 1: PRD + Docs + Code Review (March 19, 6:00-6:19 PM)

### The Spark

**csmoove (6:00 PM):** @JR you there

**JR (6:00 PM):** Yeah, I'm here. What's up?

**csmoove (6:01 PM):** I'd like for you to put together a PRD for a new service that we want to build that we would sell to acquirers to enable them to offer merchants the ability to spin up an MPP protocol compatible endpoint for the MPP card spec that Visa launched yesterday similar to what Stripe announced in their blog to enable their merchants to support MPP. Any questions on what this should look like or can you go ahead and start the PRD?

### JR's Initial Research + Clarifying Questions (6:02 PM)

JR pulled in the latest on what Visa shipped and what Stripe announced to ground the PRD in specifics. Key context gathered:

- MPP (Machine Payments Protocol) launched that week as an open standard co-authored by Stripe and Tempo
- Visa released the card-based MPP spec, an SDK (mpp-card), and integration with Visa Intelligent Commerce for encrypted network tokens
- Stripe was enabling its merchants to accept MPP payments in a few lines of code via PaymentIntents

JR asked 4 clarifying questions:
1. **Target acquirer persona:** Traditional acquirers (Worldpay, Fiserv, Adyen) or also smaller PSPs?
2. **Scope of "spin up an endpoint":** Managed service or SDK/platform for acquirers to white-label?
3. **Payment methods:** Card-only via Visa spec, or also Stripe SPT and Tempo stablecoin?
4. **Relationship to mpp-card-servers:** Starting point or net-new?

### ad's Input (6:03 PM)

Cuy brought in a second agent (ad) for feedback. ad confirmed:

- The opportunity is real and timing is perfect
- The core value prop: acquirers can offer MPP without merchants migrating to Stripe
- The card flow is well-defined (HTTP 402 challenges, encrypted network tokens, Visa Intelligent Commerce)
- Settlement goes through existing card rails (the beauty of the architecture)

ad raised key questions for the PRD:
- Hosting model (managed vs. acquirer-deployed)
- RSA key management at scale
- Credential issuer relationship
- Pricing model
- Stablecoin support scope

### Cuy's Direction (6:05 PM)

**csmoove:** In addition to @ad's feedback:
- Focused on targeting traditional acquirers like Worldpay who want to compete with Stripe
- The vision is a self-serve tool for developer-facing merchants to turn existing APIs into MPP card-compatible endpoints
- Focus on Visa MPP card spec only
- Detailed docs at mpp.sh
- Proceed and write V1 of the PRD and publish to GitHub

### PRD Written + Published (6:08-6:09 PM)

JR wrote and pushed the PRD to https://github.com/JR2321/mpp-endpoint-service

PRD covered:
- **Problem:** Stripe is the only turnkey path for MPP card payments. Every non-Stripe acquirer is locked out.
- **Product:** Self-serve tool, two modes (hosted proxy + middleware)
- **8 requirements** with acceptance criteria (protocol compliance, self-serve config, RSA keys, gateway adapters, proxy mode, middleware mode, sandbox, discovery)
- **6 open questions** (deployment model, pricing, VIC onboarding, target acquirers, PCI scope)

### ad's PRD Review (6:13 PM)

Cuy asked ad to review the PRD. ad gave it **7/10** with detailed feedback:

**Strengths:**
- Problem statement is sharp ("every acquirer that isn't Stripe is locked out")
- Protocol summary accurate to spec
- Managed proxy is right for V1
- Good scope discipline (Visa card charge only)

**Critical Issues Raised:**
1. **PCI problem is understated.** Decrypting JWE tokens with PANs = PCI DSS Level 1 scope from day one, not a Phase 3 concern
2. **Missing SDK/sidecar deployment option.** Large acquirers won't route traffic through a third-party proxy. Need on-prem path for V2.
3. **Static pricing is too rigid.** Need dynamic pricing via webhook/callback for compute-dependent APIs
4. **Generic ISO 8583 bridge is hand-waving.** It's one adapter per acquirer.
5. **Missing observability and reconciliation.** Acquirers need to map MPP receipts to settlement records.
6. **Open Question #1 is already answered.** Credential issuance is the client side's responsibility per the spec.
7. **PCI timeline is aggressive.** Level 1 assessment takes 3-6 months.

### JR's Response to Feedback (6:16 PM)

JR triaged ad's feedback:

**Incorporating:**
- PCI scope: front-load as core design decision, not footnote. Two paths: accept PCI Level 1, or redesign for encrypted pass-through to acquirer.
- On-prem/sidecar: explicit V2 commitment for enterprise acquirers
- Dynamic pricing: webhook callback option before issuing 402 challenge
- Observability: dedicated reconciliation section
- Open Question #1: moved to stated design assumption

**Pushing back on:**
- ISO 8583 bridge: already spec'd as one adapter per acquirer
- PCI timeline: depends on architecture decision (pass-through would shrink scope dramatically)
- Credential fields table: keep inline for engineers

**Added:**
- Competitive landscape section
- LOIs/pilots as separate success metric

### Build Request (6:16 PM)

**csmoove:** go ahead and build v1 based on latest PRD

### Documentation Published

JR published 7 developer docs to the repo, built to Stripe/Twilio standard:
- index.md, quickstart-proxy.md, quickstart-middleware.md, api-reference.md, gateway-adapters.md, errors.md, testing.md

---

## Session 2: V1 Code Build (March 20, 1:22-3:33 AM UTC)

### Picking Back Up

Cuy shared the Session 1 transcript and asked JR to pick up where things left off and write the code.

### What JR Built

JR cloned the repo (which already had PRD, docs, and a solid codebase from the first session's ad agent work), verified all existing tests passed (19 tests, all green), then built out the remaining PRD requirements:

**New files:**
- `src/middleware.ts` -- Middleware mode (R6). Drop-in MPP card gating for Hono, Express, or any Fetch API server. Supports dynamic pricing via function callback or webhook URL.
- `src/middleware.test.ts` -- 4 tests: 402 flow, payment passthrough, dynamic pricing, replay protection
- `src/gateway-worldpay.ts` -- Worldpay XML Direct adapter stub with full request structure documented in comments
- `src/gateway-fiserv.ts` -- Fiserv Commerce Hub adapter stub with HMAC signing scaffold
- `Dockerfile` -- Multi-stage build for production deployment

**Updated files:**
- `src/types.ts` -- Added `pricing_webhook_url` and `gateway_adapter` fields
- `src/store.ts` -- Handles new fields on create/update
- `src/mpp-handler.ts` -- Dynamic pricing resolution (calls webhook before 402), per-endpoint gateway adapter override
- `README.md` -- Full rewrite covering both integration modes
- `.env.example` -- All config vars for Worldpay and Fiserv

**Test results:** 23 tests across 8 suites, all passing.

### Email Summary Sent

JR sent an exec-friendly email to Cuy covering:
- The problem (non-Stripe acquirers locked out of agent commerce)
- What was built (both integration modes, full feature list)
- Go-to-market strategy: CyberSource first, then expand
- Ask: identify 5 developer-facing merchants on CyberSource as design partners
- 5 recommended next steps
- 5 open strategic questions

Product renamed to **MPP Merchant Endpoint-as-a-Service** per Cuy's direction.

---

## Key Decisions Made

| Decision | Who | When |
|----------|-----|------|
| Target traditional acquirers (Worldpay, Fiserv), not PSPs | Cuy | Session 1 |
| Visa MPP card spec only for V1 (no stablecoins) | Cuy | Session 1 |
| Self-serve tool, not white-label platform | Cuy | Session 1 |
| Two modes: proxy (hosted) + middleware (embedded) | JR + ad | Session 1 |
| PCI scope is a core design decision, not a footnote | JR (from ad's feedback) | Session 1 |
| Dynamic pricing via webhook callback | JR (from ad's feedback) | Session 1 |
| CyberSource as first production gateway target | Cuy | Session 2 |
| Need 5 CyberSource design partners to validate | Cuy | Session 2 |
| Product name: "MPP Merchant Endpoint-as-a-Service" | Cuy | Session 2 |

## Open Items

1. **PCI scope architecture decision:** Decrypt tokens ourselves (PCI Level 1) vs. pass encrypted payloads to acquirer (minimal PCI scope)
2. **Identify 5 developer-facing merchants on CyberSource** as design partners
3. **Build CyberSource gateway adapter** (1-2 weeks estimated)
4. **Deployment model:** Multi-tenant SaaS vs. single-tenant per acquirer
5. **Pricing model:** Per-endpoint, per-transaction, or platform licensing
6. **Persistent storage:** Replace in-memory store with Postgres
7. **Management API authentication:** API keys scoped per merchant

## Artifacts

- **Repo:** https://github.com/JR2321/mpp-endpoint-service
- **PRD:** https://github.com/JR2321/mpp-endpoint-service/blob/main/PRD.md
- **Docs:** https://github.com/JR2321/mpp-endpoint-service/tree/main/docs
- **Discord channel screenshot:** Attached (shows the #mpp-endpoint-as-a-service channel where this product was conceived)
