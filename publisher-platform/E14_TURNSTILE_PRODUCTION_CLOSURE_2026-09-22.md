# E14 — Publisher Authentication Turnstile Hardening

Status: CLOSED / PASS
Date: 2026-09-22

## Git checkpoint

- HEAD: `2514cc3e81dafa3d70b0ae9c13f4680bf4ec563d`
- Turnstile implementation commit: `792cc3219d921560dfdb6509604779d75062de49`
- Production Site Key commit: `2514cc3e81dafa3d70b0ae9c13f4680bf4ec563d`

## Production Worker versions

### Publisher App
- Current: `4dd3c8a4-90a3-4fb6-a773-bb0c6e066324`
- Pre-E14 rollback version: `d018c062-2b23-4410-9f3c-036acc1d5fbc`

### Auth API
- Current: `2fafe9ea-7750-494f-b7d8-78ec2b5fab9d`
- Pre-E14 rollback version: `55bc6ae9-4f8b-4d5b-9c84-4940a089e250`

## Controls

- Cloudflare Managed Turnstile enabled on Production login.
- Server-side Siteverify required in Production.
- Siteverify validates hostname and action.
- Cloudflare official testing-key responses are rejected in Production.
- Turnstile secret stored only as Worker secret.
- Turnstile secret is not stored in Git.
- Email rate limit: 3 requests / 60 seconds.
- IP rate limit: 20 requests / 60 seconds.
- Missing Turnstile token fails closed with HTTP 400.

## Production acceptance

Real browser flow passed:

`/login`
→ Managed Turnstile
→ Siteverify
→ existing publisher owner
→ magic-link creation
→ Resend delivery
→ magic-link consumption
→ session creation
→ existing active publisher recognition.

## Final Production D1 state

- events: 145
- users: 1
- publishers: 1
- memberships: 1
- supplier_offers: 1
- placements: 5
- publisher account_status: active
- primary domain monetization_status: enabled
- foreign-key errors: 0

Magic-link token hash length: 64.
Session token hash length: 64.
Latest Production session is not revoked.

No new test user or publisher was created during Production acceptance.

## Test evidence

- Full publisher regression suite: 981 / 981 PASS.
- TEST Turnstile browser flow: PASS.
- TEST magic-link/session lifecycle: PASS.
- Production browser flow: PASS.
- Production D1 post-deployment acceptance: PASS.

## Production safety

E14 did not modify:

- legacy event data
- existing publisher identity
- existing supplier offer
- existing placement attribution
- monetization state
- existing Trip.com commercial configuration

E14 Production Turnstile hardening is formally CLOSED / PASS.
