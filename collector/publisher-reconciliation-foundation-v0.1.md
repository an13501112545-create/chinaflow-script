# Publisher Reconciliation Foundation v0.1

## Purpose

Define the accounting boundary between Supplier-reported commission facts and Publisher earnings.

This layer exists because a row in `trip_commissions` is Supplier reporting, not proof that ChinaFlow has actually received and retained Net Commission Revenue.

## Non-negotiable separation

The durable flow is:

```text
trip_commissions
  -> Supplier-reported commission facts

publisher_commission_reconciliations
  -> append-only Approved Commission decisions

publisher_net_commission_revenue_entries
  -> append-only actual received/retained Net Commission Revenue ledger

publisher_commercial_terms
  -> append-only Publisher share / settlement rules

future publisher settlement ledger
  -> may calculate Publisher earnings only from reconciled Net Commission Revenue
```

Never calculate Publisher earnings as:

```text
trip_commissions.commission_amount_micros * publisher_share
```

The Supplier commission amount may be pending, rejected, reversed, adjusted, withheld, or otherwise not finally received and retained by ChinaFlow.

## Supplier fact immutability boundary

Reconciliation must not repurpose or mutate `trip_commissions` fields to represent internal approval, receipt, settlement, or Publisher payout.

A reconciliation decision references a Supplier commission fact but stores its own immutable snapshot of the approved economic fact and Publisher attribution.

This matters because Supplier facts can later be re-imported or materially corrected. Historical internal reconciliation evidence must remain auditable rather than silently changing with the source row.

## Approved Commission decision

An Approved Commission decision must be an explicit internal reconciliation fact. It must not be inferred merely because:

- `normalized_commission_status = 'settled'`;
- a Supplier commission amount is positive;
- an order is completed;
- a `trip_sub1` exists;
- a booking/commission row is attributed to a Publisher.

The reconciliation record must identify:

- the exact `commission_fact_id` and `commission_record_key`;
- the Publisher and placement snapshot being approved;
- the approved amount and currency snapshot;
- a decision state (`approved` or a later `reversed` decision);
- an external/internal evidence reference;
- when that decision became effective.

The history is append-only. A reversal is a new decision, never an UPDATE or DELETE of the prior approval.

## Net Commission Revenue ledger

Net Commission Revenue is an accounting fact asserting that an amount was actually received and retained by ChinaFlow after relevant reversals, chargebacks, cancellations, taxes, withholding, Supplier adjustments, or other non-retained amounts.

A Net Commission Revenue entry must:

- reference a specific Approved Commission decision;
- preserve the Publisher snapshot;
- carry a signed amount in an explicit currency;
- carry an evidence reference and effective timestamp;
- be append-only.

Positive entries recognize received/retained Net Commission Revenue. Later reversals or adjustments are represented as additional signed entries; prior entries are never rewritten.

## Currency and FX boundary

`trip_commissions.currency` is Supplier report currency.

`publisher_commercial_terms.settlement_currency` is the Publisher settlement currency.

Neither one authorizes an FX conversion.

The reconciliation layer must preserve the actual currency of each Net Commission Revenue entry. If Net Commission Revenue is not already denominated in the Publisher settlement currency, a future settlement process must require an authoritative FX/conversion fact before calculating settlement-currency Publisher earnings.

Do not invent an exchange rate. Do not silently reuse a booking date, commission month, card rate, market rate, or current FX rate.

## Tenant isolation

Reconciliation records must preserve `publisher_id` as an explicit immutable snapshot.

At creation time, a new approval must be consistent with the referenced Supplier commission fact:

- `attribution_status = 'matched'`;
- `attributed_publisher_id` is non-null;
- the reconciliation `publisher_id` equals the Supplier fact's attributed Publisher;
- the reconciliation placement equals the Supplier fact's attributed placement.

Publisher-facing queries must authorize by `publisher_id`, never by `trip_sub1` or Supplier order ID alone.

## Current-state semantics

The current Approved Commission state for one Supplier commission fact is its latest append-only reconciliation decision.

Only a latest decision of `approved` can support new Net Commission Revenue recognition.

A later `reversed` decision does not delete existing Net Commission Revenue history. Any financial correction must be represented by corresponding negative/reversal Net Commission Revenue entries, preserving the audit trail.

## Scope of v0.1

v0.1 may create only the append-only reconciliation and Net Commission Revenue schema plus integrity tests.

v0.1 does not:

- auto-approve Supplier commissions;
- parse Supplier settlement files;
- invent settlement evidence;
- calculate Publisher earnings;
- perform FX conversion;
- create Publisher payout records;
- create a new Worker or database.

A future internal reconciliation writer/importer must have separate authorization and idempotency controls before any Production reconciliation rows are created.
