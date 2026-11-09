# Search strategy experiment results

Measured: 2026-10-26, approximately 06:51–07:04 UTC.

## Bottom line

**Two unique search-reported zero observations qualified in the corrected eight-request follow-up.** They are explicit YouTube “No views” labels with conservative old-enough age evidence, not independently verified numeric counters. The experiment did not insert any archive records.

## Corrected follow-up

All eight pages returned HTTP 200, using one sequential requester at 0.5 requests/second.

| Approach | Requests | Eligible reported zeros | Interpretation |
| --- | ---: | ---: | --- |
| Rare term + narrow date window | 1 | 1 | `abstemious` in an October 2025 window returned an explicit zero labelled `1y ago`; conservative minimum age 180 days. |
| Specific camera filenames | 3 | 1 | `MVI_2379` returned an explicit zero labelled `13y ago`; the tested `IMG_1573` and `MOV_0034` variants returned none. |
| Other rare/dated-filename queries | 2 | 0 | No qualifying hits for the tested `scolecophidian` / `VID_2017` queries. |
| Known small-channel catalogues | 2 | 0 supported | **Inconclusive:** one page supplied 30 modern cards without the named legacy count field; the other supplied no supported cards. This is not proof the channels lack zero-view videos. |

The two positive observations had different hashed identities, and neither was already in the numeric-verified archive at the overlap check. Only minimal count/age evidence and hashes were retained, not titles, descriptions or database rows.

## Pacing comparison and a real parser defect

The initial paired comparison used eight queries at 1 request/second and the same eight at 0.25 requests/second. **Both completed 8/8 pages successfully**, with no HTTP 403/429 or native transport failure. Slower pacing did not improve the explicit-zero-label result in this sample.

That initial run saw the same narrow-query zero label at both rates but incorrectly rejected it because its actual age string was `1y ago`, not `1 year ago`. A separate one-request diagnostic identified the mismatch. Compact `d`, `w`, `mo`, `y` forms now have regression coverage; minutes (`m`) are not interpreted as months, and uncertain seven-day/one-week boundaries remain rejected. Only the corrected follow-up is used above to rank eligible observations.

Broad IMG, generic first-file names and the tested niche phrase produced no explicit zero labels in the initial sample. Query specificity was more promising than simply changing request rate. The small sample does not establish a globally optimal strategy.

## Budget and correctness

- 24 benchmark requests plus one targeted diagnostic: **25 live requests total**.
- All 24 benchmark pages returned HTTP 200; no site-denial deadline was cleared.
- The isolated benchmark excluded only the application's own `fetch failed` circuit heuristic, not HTTP access/rate-limit backoff.
- Roughly 27.2 MiB of decoded HTML were examined across the 24 benchmark pages; wire/compressed transfer size was not measured.
- The numeric archive was unchanged by each benchmark. The production service was restored after each isolated run.
- Type checks and **60 tests** pass locally, including source-field binding, compact age forms, old-enough boundaries, live-video rejection and no invented upload dates.

## Keep / do not promote yet

**Keep:** compact-age parsing; explicit separation of reported evidence from numeric verification; specific filename and narrow rare-term candidates for a larger trial; sequential request testing.

**Do not claim:** that lower pacing solved production networking, that the tested channel catalogues are unproductive, or that two observations predict sustained daily yield. Production's concurrent transport failures were not reproduced in this short sequential comparison, so their cause is not established.

**Recommendation:** expand the two promising query families, add a properly bound modern-card count reader, and collect the approved reported-zero tier separately. Do not spend more traffic on blind popular-topic searches or convert unknown counts into zeros.

## Separate production progress

At 07:20 UTC, the background collector had **53 numeric-verified RSS records**, up from the earlier two. All 53 passed a read-only literal-zero and seven-day-at-observation check; a new online snapshot passed integrity checking and protected all 53. The benchmark did not create those records or add its two reported-only observations to the archive.

Release `20261026T042006Z` remained active/enabled on xceg. Production still reports intermittent `fetch failed` source-circuit pauses; the short sequential tests do not establish their root cause or a permanent fix.

## Artifacts

- [Plan and hypotheses](autoresearch.md).
- [Per-request results](autoresearch.jsonl).
- [Corrected follow-up summary](summary.json).
- [Runner](autoresearch.sh) and [benchmark code](benchmark.mjs).
- [Evidence helper](../../search-evidence.ts) and [regression tests](../../test/search-evidence.test.ts).
