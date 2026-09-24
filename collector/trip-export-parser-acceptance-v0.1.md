# Trip.com Export Parser Acceptance v0.1

## Purpose

Define the minimum evidence and parser contract required before ChinaFlow accepts a real Trip.com booking or commission export into the existing Reporting Importer pipeline.

This document does not define or guess Trip.com CSV/XLSX column names. A real export file is the authority for source headers and source value formats.

## Current boundary

The existing internal Reporting Importer Worker is already deployed in TEST and Production.

It accepts authenticated multipart input containing:

- `command_type`
- `aid`
- `source_filename`
- optional `report_period_from`
- optional `report_period_to`
- `rows_json`
- original uploaded `file` bytes

Supported command types:

- `trip.booking.import`
- `trip.commission.import`

The Worker does not parse raw Trip.com CSV/XLSX files. The parser/adapter must convert the real export rows into the existing `rows_json` contract while preserving the original file bytes for source-file SHA-256 dedupe.

## Evidence required before parser implementation

Do not implement a production parser until at least one real Trip.com export is available for each actual report format used by ChinaFlow:

1. Order / booking report export.
2. Commission report export.

If Trip.com supplies a single combined export instead, use that real format rather than inventing two files.

For each file, record without modifying the original bytes:

- original filename
- file type (`csv`, `xlsx`, or actual type)
- text encoding when applicable
- sheet name(s) when applicable
- exact header names and order
- representative raw values for dates, amounts, currencies, statuses, IDs, blank cells, and tracking parameters
- whether repeated order IDs occur and why
- whether negative commission rows occur

Trip.com Affiliate reporting documentation confirms that order and commission reports have different update timing and that commission reports can contain negative-value reversal rows. Parser logic must preserve source signs and source values; it must not convert negative commission amounts to positive values.

## Booking parser output contract

Each booking source row must be converted to an object using these keys when the corresponding source data exists:

- `orderId`
- `sid`
- `sidName`
- `tripSub1`
- `tripSub3`
- `productLine`
- `orderStatus`
- `amount`
- `currency`
- `orderDate`
- `productStartDate`
- `productEndDate`
- `bookingWindow`
- `departureCity`
- `departureCountry`
- `arrivalCity`
- `arrivalCountry`
- `orderPlatform`
- `region`
- `ouid`

Booking identity is fail-closed. The following row fields must resolve to nonblank strings because they participate in the deterministic record key:

- `orderId`
- `sid`
- `productLine`

The importer context supplies the other booking identity inputs:

- `source`
- `aid`

`tripSub1` is not required for ingestion, but missing or unknown `tripSub1` must remain unattributed rather than being guessed.

## Commission parser output contract

Each commission source row must be converted to an object using these keys when the corresponding source data exists:

- `orderId`
- `sid`
- `sidName`
- `tripSub1`
- `tripSub3`
- `productLine`
- `subOrderType`
- `planType`
- `orderStatus`
- `commissionStatus`
- `bookingAmount`
- `commissionAmount`
- `currency`
- `commissionMonth`
- `orderDate`
- `checkOutOrIssueDate`
- `ratio`
- `region`
- `ouid`

Commission identity is fail-closed. The following row fields must resolve to nonblank strings because they participate in the deterministic commission record key:

- `orderId`
- `sid`
- `commissionMonth`
- `productLine`
- `subOrderType`
- `planType`

The importer context supplies:

- `source`
- `aid`

`tripSub1` may be absent, but absence must remain `missing_trip_sub1`; parser logic must not fabricate attribution.

## Value-preservation rules

The parser must preserve source meaning before normalization:

- IDs must stay strings; do not coerce them to numbers.
- Money values must be passed as source strings without thousands-format invention or sign changes.
- Negative values must remain negative.
- Blank source cells must not be replaced with guessed business values.
- Unknown product/status codes must be preserved so the existing normalizer can classify them as `unknown`.
- Dates must not be reformatted until the real source format is observed and explicitly mapped.
- Tracking fields such as `tripSub1`, `tripSub3`, `sid`, and `ouid` must not be reconstructed from unrelated fields.
- The original export file bytes must be retained unchanged for `source_file_sha256`.

## Acceptance sequence

1. Save an untouched real export fixture outside Production data paths.
2. Inventory exact headers and raw value examples.
3. Write parser fixtures from the real file only; do not synthesize undocumented source columns.
4. Implement the smallest parser/adapter that emits the existing booking or commission row contract.
5. Add parser tests for:
   - required identity fields
   - blank/missing identity rejection
   - negative commission preservation
   - unknown statuses/products
   - missing/unmatched `tripSub1`
   - repeated order IDs where the real report legitimately produces them
   - exact source-file bytes and filename handoff
6. Pass the existing reporting importer suite unchanged.
7. Run TEST ingestion with the real export and verify:
   - ingestion ledger row
   - source-file dedupe
   - attribution result
   - insert/update/unchanged planning
   - atomic persistence
   - no cross-publisher exposure
8. Re-import the exact same file and require duplicate-file behavior with no duplicate facts.
9. Only after TEST acceptance, prepare the first guarded Production ingestion.

## Current blocker

As of 2026-09-24, no real Trip.com booking/commission export is available in the repository, ChatGPT Project/Library files, connected Google Drive, or the inspected local project tree.

Until a real export is available, parser field mapping remains intentionally unimplemented.
