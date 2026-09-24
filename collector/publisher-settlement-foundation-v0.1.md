# Publisher Settlement Foundation v0.1

## Purpose

Define the first safe accounting layer that can recognize Publisher earnings from actual Net Commission Revenue without inventing FX, rounding, payout, or payment facts.

The durable accounting flow is:

```text
trip_commissions
  -> Supplier-reported commission facts

publisher_commission_reconciliations
  -> append-only Approved Commission decisions

publisher_net_commission_revenue_entries
  -> append-only actual received/retained Net Commission Revenue

publisher_commercial_terms
  -> append-only Publisher share / settlement rules

publisher_earnings_entries
  -> append-only Publisher earnings accrual facts

future payout ledger
  -> payment scheduling / payment execution facts
```

## Earnings basis

Publisher earnings may be recognized only from a specific `publisher_net_commission_revenue_entries` row.

A Supplier commission row, Approved Commission decision, booking value, order status, or commission status is not by itself an earnings basis.

One Net Commission Revenue entry may produce at most one Publisher earnings entry in v0.1. Signed Net Commission Revenue adjustments are separate source entries and therefore produce separate signed earnings entries.

## Commercial-terms version

The earnings entry must reference the latest Publisher commercial-terms version whose `effective_from` is on or before the Net Commission Revenue entry's `effective_at`.

The earnings entry snapshots:

- `commercial_terms_id`;
- `publisher_share_bps`;
- settlement currency;
- Publisher / placement identity from the Net Commission Revenue entry.

A later commercial-terms version never rewrites prior earnings history.

## Same-currency v0.1 boundary

v0.1 may recognize Publisher earnings only when:

```text
Net Commission Revenue currency == commercial terms settlement currency
```

If currencies differ, no Publisher earnings entry may be created.

Cross-currency earnings require a future authoritative conversion fact. v0.1 does not choose an FX source, infer a rate, reuse a booking/commission date, query a market rate, or manufacture a converted amount.

## Exact micros arithmetic

The Publisher share is expressed in basis points (`publisher_share_bps`, denominator 10,000).

v0.1 does not define or invent a rounding policy. An earnings entry is valid only when the share calculation is exact at micro-unit precision:

```text
publisher_earnings_micros
  = net_commission_revenue_micros * publisher_share_bps / 10000
```

If the result is not an exact integer number of micros, creation must fail closed. No floor, ceiling, banker's rounding, half-up, half-away-from-zero, or other rounding rule is implied.

The same rule applies to positive and negative Net Commission Revenue entries.

## Settlement cycle

For v0.1, the earnings settlement-cycle month is the calendar `YYYY-MM` containing the Net Commission Revenue entry's `effective_at` timestamp.

This implements the current Publisher Terms rule that earnings enter the monthly settlement cycle only after the relevant commission has become Approved Commission and has been included in Net Commission Revenue.

## Minimum payout threshold

`minimum_payout_micros` does not determine whether earnings exist.

Earnings accrue regardless of whether the accumulated payable balance has reached the regular minimum payout threshold. Threshold evaluation belongs only to a future payout scheduling layer.

A future payout layer must also preserve the contractual rule that final settlement after termination is not subject to the ordinary US$100 threshold.

## Append-only boundary

Publisher earnings are accounting facts and must be append-only.

Corrections are represented by later signed source Net Commission Revenue entries and corresponding signed earnings entries. Existing earnings rows are never updated or deleted.

## Tenant isolation

Each earnings entry preserves `publisher_id` and `attributed_placement` from its source Net Commission Revenue entry.

Publisher-facing reads must continue to authorize by `publisher_id`; placement or Supplier identifiers never authorize tenant access.

## Scope of v0.1

v0.1 may create only the append-only `publisher_earnings_entries` foundation and integrity tests.

v0.1 does not:

- create earnings from Supplier commission rows directly;
- create earnings without Net Commission Revenue;
- perform FX conversion;
- define a rounding policy;
- create payout batches or payment records;
- mark earnings as paid;
- apply the minimum payout threshold;
- send money;
- create a new Worker or database.

A future internal earnings writer must have separate authorization/idempotency or be safely incorporated into an already-authorized accounting writer before Production earnings rows are created.
