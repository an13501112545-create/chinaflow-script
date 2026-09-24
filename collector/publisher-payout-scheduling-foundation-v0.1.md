# Publisher Payout Scheduling Foundation v0.1

## Purpose

Define the accounting and lifecycle facts that must exist before ChinaFlow creates a Publisher payout scheduling ledger.

This foundation intentionally does **not** create payout batches, payment instructions, payment-provider integrations, beneficiary/KYC workflows, FX conversions, or money movement. Actual payment execution remains offline/manual.

The durable accounting path is:

```text
trip_commissions
  -> Supplier-reported commission facts

publisher_commission_reconciliations
  -> append-only Approved Commission decisions

publisher_net_commission_revenue_entries
  -> append-only actual received/retained Net Commission Revenue

publisher_earnings_entries
  -> append-only accrued Publisher earnings

future manual settlement ledger
  -> operator-confirmed payable / settled / carry-forward accounting facts

offline payment
  -> executed outside ChinaFlow (bank transfer / Wise / PayPal / other manual channel)
```

## Contractual basis

Publisher Terms v1 currently require:

- monthly settlement cycles;
- earnings become settlement-eligible only after Approved Commission and Net Commission Revenue exist;
- eligible earnings are normally payable within 30 days after the applicable monthly cycle;
- the ordinary minimum payout is US$100 under standard terms;
- amounts below the ordinary threshold are carried forward and are not forfeited;
- following termination, final Publisher earnings are settled without applying the ordinary US$100 threshold;
- payment execution may be delayed for missing payment, tax, identity, KYB/KYC, sanctions, or other lawful processing requirements.

## Existing authoritative facts

ChinaFlow currently has authoritative append-only facts for:

- commercial terms versions;
- Approved Commission decisions;
- Net Commission Revenue;
- Publisher earnings accruals.

Publisher earnings already snapshot:

- Publisher / placement identity;
- commercial-terms version;
- settlement currency;
- Publisher share basis points;
- settlement-cycle month;
- exact earnings micros;
- effective timestamp.

These facts are sufficient to establish accrued earnings. They are **not** sufficient to establish a final payout obligation or payment execution status.

## Missing authoritative termination fact

`publishers.account_status` currently includes `closed`, but the Publisher schema has no immutable `terminated_at` or append-only relationship-termination event.

`publishers.updated_at` is not a termination fact. It may change for unrelated reasons and must never be used to determine when final-settlement rules became effective.

A payout scheduler therefore must not infer termination from:

- `account_status='closed'` alone;
- `updated_at`;
- a domain release/revoke timestamp;
- monetization disablement;
- the last click, booking, commission, reconciliation, or earnings timestamp.

Before final-settlement threshold exemption can be implemented, ChinaFlow needs an authoritative, immutable relationship-termination fact with an effective timestamp.

## Offline payment boundary

ChinaFlow does not need to execute Publisher payments in-product. Actual payout may be completed manually outside the platform using the operator's chosen payment channel.

The system therefore does not need to model or automate:

- payout destination / beneficiary onboarding;
- payment-provider integrations;
- automated KYB/KYC payment gating;
- bank/payment execution attempts;
- transfer status webhooks.

The minimum useful system responsibility is accounting control: know which accrued earnings remain unsettled and which earnings were included in a manually completed settlement, so the same earnings cannot be paid twice.

## Regular monthly payout threshold

The ordinary minimum payout threshold does not determine whether earnings exist.

A future scheduler may evaluate accumulated **unpaid, same-settlement-currency earnings** against the applicable commercial terms, but it must not:

- discard sub-threshold earnings;
- mark them as paid;
- silently convert currencies;
- net earnings across different currencies;
- infer a threshold from current terms when historical earnings reference a different terms version.

The exact rule for threshold evaluation across multiple commercial-terms versions must be defined before implementation. Until then, no threshold scheduler should be created.

## Final settlement

Final settlement after relationship termination is a separate scheduling mode.

It must:

- use an authoritative termination effective timestamp;
- include only earnings that remain properly payable under the Terms;
- preserve pre-termination attribution rules;
- not apply the ordinary recurring minimum payout threshold;
- remain separate from payment execution / paid status.

The current schema cannot safely implement this rule because the termination effective timestamp does not yet exist.

## Currency / FX boundary

Payout scheduling may operate only on earnings already denominated in the applicable settlement currency.

Cross-currency Net Commission Revenue remains outside payout scheduling until an authoritative conversion fact exists and produces a valid settlement-currency earnings fact.

Do not invent or query a market FX rate inside payout scheduling.

## Append-only boundary

Future payout scheduling facts should be append-only accounting decisions.

Corrections should be represented by later adjustment facts, not destructive updates to earnings history.

Actual money movement remains outside ChinaFlow. If settlement completion is recorded in-system, it should be an operator-confirmed accounting fact referencing the offline payment evidence, not a payment-execution workflow.

## Current implementation gate

As of 2026-09-24, do **not** create the payout scheduling migration or writer yet.

The next safe engineering prerequisite is to model the Publisher relationship termination fact explicitly and immutably. Only after that fact exists should ChinaFlow finalize:

1. recurring threshold / carry-forward semantics across terms versions;
2. final-settlement threshold exemption;
3. payout obligation grouping and due-date rules;
4. the minimal operator-confirmed manual settlement record;
5. the append-only settlement accounting schema.

Do not build a payment execution system unless separately approved later.
