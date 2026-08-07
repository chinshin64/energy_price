---
name: amap-fuel-capture
description: Use when developing, debugging, reviewing, or testing the Android APK that captures Amap/Gaode fuel-station pages. Enforces station switching, detail/payment two-stage capture, required fuel fields, 92#/95# grade authority and price-ranking fallback, payment math, CP normalization, one-record-per-grade isolation, upload readiness, and regression checks.
---

# Amap Fuel Capture

## Purpose

Keep every future APK iteration aligned to the same collection target instead of re-deciding the business rules each time.

The APK must reliably move through Amap fuel stations one station at a time, capture the required fields from detail/payment pages, merge the two stages without cross-station contamination, resolve 92#/95# safely, validate payment math, save one complete record per fuel grade, and only then upload through the existing mobile-source path.

Treat the user-provided screen recording as a navigation reference: station list -> enter a station -> inspect fuel/detail information -> enter the ¥200 purchase/payment flow -> return -> switch station -> repeat. Do not treat values visible in that recording as golden OCR fixtures unless the user explicitly promotes them to test data.

## Non-negotiable rules

1. Never merge data across different stations.
2. Never overwrite a visually explicit selected fuel grade with an inferred grade.
3. The presence of both `92#` and `95#` rows is not proof that either one is selected.
4. When the same station/session has exactly two distinct display prices and no authoritative grade is available, lower display price = `92#`, higher display price = `95#`.
5. With only one ambiguous price, keep the record pending; do not guess the grade.
6. The purchase amount for this workflow is fixed at `200` yuan.
7. `serviceFee = payableAmount - (200 - discountAmount)` when the page does not expose an explicit service fee.
8. Do not upload an incomplete or mathematically inconsistent fuel record.
9. One station + one fuel grade produces one logical record; repeated OCR should update/merge, not create uncontrolled duplicates.
10. Do not hardcode ingest secrets in APK source or in this skill.
11. Keep the current floating-recognition window unchanged unless the user explicitly asks to redesign it.
12. Do not claim real-device or real-page OCR success unless it was actually validated on a device/page. Unit tests and CI builds are not end-to-end OCR proof.

## Collection state machine

Use this conceptual state machine even if implementation classes differ:

`STATION_LIST -> STATION_ACTIVE -> DETAIL_CAPTURE -> PAYMENT_CAPTURE -> GRADE_RESOLUTION -> SAVE -> NEXT_GRADE_OR_STATION`

### 1. STATION_LIST

- Show/inspect Amap's station list.
- Select the next station that has not completed the required capture for the current run.
- When a station is opened, establish a new active station context.
- Do not carry unresolved candidates from the previous station into the new station context.

### 2. STATION_ACTIVE

Create a stable station key from the recognized station name and current capture/session context.

Station matching policy:

- Prefer exact normalized station-name matching.
- Safe substring/fuzzy fallback is acceptable only when it cannot select a different station.
- A payment page may abbreviate or slightly change station text; match it to the active station only when the evidence is unambiguous.
- If station identity is ambiguous, keep the capture pending/manual-review instead of silently attaching it to another station.

### 3. DETAIL_CAPTURE

The detail-stage target is:

- `stationName`
- explicit selected `grade` when visually available
- `stationPrice`
- `displayPrice`

Store this as a candidate for the active station. Detail capture is allowed to be incomplete for payment-only fields.

### 4. PAYMENT_CAPTURE

The payment-stage target is:

- `stationName` when visible
- `displayPrice` when visible
- `amount = 200`
- `discountAmount`
- `payableAmount`
- explicit `serviceFee` when visible, otherwise derived service fee
- `providerName` / `CP`

Merge payment data only into a candidate from the same active station/session.

### 5. GRADE_RESOLUTION

Grade authority order:

1. Visual selected-grade evidence from the current page.
2. A previously cached explicit selected grade for the same candidate.
3. Same-station two-display-price ranking: lower = `92#`, higher = `95#`.
4. Pending/manual review.

Price-ranking fallback is valid only when:

- the candidates belong to the exact same station/session;
- there are exactly two distinct display prices;
- the target grade is not already authoritative;
- the inference does not create a contradiction with an explicit grade.

When the second price arrives, re-run resolution so a previously pending first candidate can be assigned and saved retroactively.

### 6. SAVE

A fuel record is submission-ready only when the required fields are present and the payment relationship is consistent.

Required logical record:

| Field | Source / rule |
| --- | --- |
| `stationName` | OCR, detail preferred |
| `grade` | visual explicit > cached explicit > two-price fallback |
| `amount` | fixed `200` |
| `stationPrice` | detail page |
| `displayPrice` | detail/payment merged |
| `discountAmount` | payment page, e.g. `加200省¥5.09` |
| `serviceFee` | explicit page value or derived formula |
| `payableAmount` | payment page |
| `providerName` / `CP` | payment/provider evidence |
| `capturedAt` | app-generated timestamp |
| platform metadata | existing Amap fuel mobile-source contract |

Do not fabricate `stationPrice`, `discountAmount`, `payableAmount`, or `CP` when OCR evidence is absent.

### 7. NEXT_GRADE_OR_STATION

- If another grade for the same station is still required, stay in the same station context and capture it.
- Once the station's available/required grade records are complete, return to the Amap list and switch to the next station.
- Clear active candidates only after they are safely persisted or intentionally left as recoverable pending state.

## OCR and parsing guidance

### Station name

- Prefer the station title/header area.
- Strip obvious UI decorations, coupon text, distance text, and price fragments.
- Preserve the full meaningful station name.

### Fuel grade

Visual selection is authoritative. Examples of authoritative evidence include a selected tab/row state or an internally generated visual marker such as a selected-state annotation.

Do not mark a grade explicit merely because OCR text contains `92#优惠` or `95#优惠`.

### Prices

Keep these concepts separate:

- `stationPrice`: station/listed pump price.
- `displayPrice`: the Amap/offer display price used for ranking 92#/95# fallback.

Do not infer one from the other.

### Discount

Recognize patterns equivalent to:

- `加200省5.09`
- `加200省¥5.09`

The numeric saved as `discountAmount` is the saved amount, not a per-liter discount unless the page explicitly states a per-liter field and the schema calls for it.

### Payable amount

Recognize the final payable/actual-pay amount, including layouts such as a large bottom amount or text around `实付` / `应付` / `含服务费`.

### Service fee

When not explicitly shown:

`serviceFee = payableAmount - (200 - discountAmount)`

Example:

- amount = `200`
- discount = `5.09`
- payable = `195.72`
- service fee = `195.72 - (200 - 5.09) = 0.81`

Use the application's existing decimal/tolerance policy for consistency checks; do not loosen validation just to make a record pass.

### CP / provider

Provider text can be small or low-contrast. It is acceptable to use a targeted lower-page crop/enlargement in addition to full-screen OCR.

Known provider normalization examples used in this project include:

- `团油`
- `易加油`
- `滴滴加油`

Normalize `滴加油` -> `滴滴加油` only when the text is in provider/CP evidence context. Do not globally rewrite unrelated OCR text.

## Candidate isolation and deduplication

- Candidate identity must include station identity and capture/session context.
- Within a station, display price may help pair detail/payment captures, but must never be used to bridge different stations.
- Repeated screenshots of the same logical candidate should merge fields and refresh evidence rather than create duplicate records.
- Final storage should maintain at most one current logical record per station + grade for the same capture scope, according to the app's existing persistence semantics.

## Upload contract

Preserve the current mobile-source fuel contract and its existing endpoint/configuration mechanism.

Expected metadata concepts include:

- `schemaVersion: 3`
- `stationType: fuel`
- `feature: fuel-quote-v1`
- `platform: amap-fuel`

Do not embed the ingest credential in source code. Provision/import secrets through the existing secure configuration flow.

Only enqueue/upload records that pass completeness and math validation. Failed uploads must remain recoverable under the app's existing retry/manual-review semantics.

## Golden regression fixtures

Use these as deterministic parser/merge/business-rule fixtures. They are not claims about current live prices.

### 浙江石油塘河供能加油站

| Grade | Station price | Display price | Discount | Service fee | Payable | CP |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 92# | 7.39 | 7.19 | 5.41 | 0.87 | 195.46 | 团油 |
| 95# | 7.86 | 7.66 | 5.09 | 0.81 | 195.72 | 团油 |

### 双龙加油站

| Grade | Station price | Display price | Discount | Service fee | Payable | CP |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 92# | 7.39 | 7.01 | 10.28 | 1.64 | 191.36 | 易加油 |
| 95# | 7.86 | 7.46 | 10.17 | 1.63 | 191.46 | 易加油 |

### 中化道达尔杭州留祥路加油站

| Grade | Station price | Display price | Discount | Service fee | Payable | CP |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 92# | 7.39 | 6.80 | 16.00 | 2.56 | 186.56 | 滴滴加油 |
| 95# | 7.86 | 7.24 | 16.00 | 2.56 | 186.56 | 滴滴加油 |

## Required tests for logic changes

Whenever code touching this workflow changes, add or preserve tests for the relevant cases:

- visual selected grade overrides all inference;
- mere presence of 92#/95# rows does not count as explicit selection;
- exactly two same-station display prices resolve lower=92#, higher=95#;
- one ambiguous price stays pending;
- second price can resolve and save the first pending candidate retroactively;
- explicit grade is never overwritten by ranking;
- different stations with similar prices never merge;
- station switch clears/isolates candidate state correctly;
- payment page with slightly different station text cannot attach to the wrong station;
- discount/payable parsing works with currency symbols and line breaks;
- service-fee derivation is correct;
- provider normalization runs only in provider context;
- incomplete records are blocked from submission;
- payment math inconsistency blocks submission;
- repeated capture does not create duplicate logical station+grade records;
- upload/retry behavior remains intact after UI/OCR changes.

## Implementation workflow for coding agents

When this skill is invoked for a code change:

1. Inspect the current implementation before editing; do not rely on stale class names from older releases.
2. Identify the smallest set of parser, capture-state, persistence, UI, and upload files affected.
3. Preserve unrelated behavior, especially the floating-recognition UI unless explicitly in scope.
4. Implement the requested change with the rules above as invariants.
5. Add targeted unit/regression tests first-class with the code change.
6. Run the Android unit-test/build workflow.
7. If CI fails because of external dependency/network infrastructure, distinguish that from a product-code/test failure and retry only when appropriate.
8. Do not merge a feature PR until the relevant tests/build pass, unless the user explicitly instructs otherwise.
9. Report exactly what was tested and what was not tested.
10. For OCR accuracy claims, require actual screenshot/device evidence; a successful compile is not enough.

## Definition of done

A change to Amap fuel capture is done only when all applicable conditions hold:

- station switching cannot leak data between stations;
- required fields are mapped to the correct page/source;
- grade authority follows the defined priority;
- two-price fallback behaves deterministically;
- payment math is validated;
- one logical record per station+grade is maintained;
- incomplete/ambiguous records remain pending instead of being guessed/uploaded;
- existing secure upload behavior is preserved;
- targeted regression tests pass;
- APK builds successfully;
- any real-device OCR validation status is stated truthfully.
