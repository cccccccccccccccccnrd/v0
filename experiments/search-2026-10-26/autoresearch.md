# Bounded explicit-zero search experiment

Date: 2026-10-26. User approved a separate search-reported tier, then requested trying different approaches and reporting measurements.

## Metric and limits

- Primary metric: unique eligible explicit-zero observations per successful public search request.
- An observation must come from the named video renderer view-count field (`No views` or `0 views`), have valid video identity (creator identity is retained when available), non-live positive duration, and conservative old-enough relative-age evidence.
- These are **search-reported**, not numeric-verified records. No production archive records are added or modified by the benchmark.
- Relative labels are approximate: days/weeks leave a full-unit margin; month/year labels use conservative minimum bounds. No exact upload timestamp is invented. Seven days / one week are rejected as boundary-uncertain.
- Budget: at most 16 requests and 90 seconds, sequential native fetch, same public URLs/locale, no cookies, accounts, proxies, alternate identities or TLS weakening.
- Honor real site-wide/source backoff. Stop on HTTP 403/429. Only the application's own `fetch failed` heuristic is excluded in the isolated experiment; actual denial/Retry-After pauses remain active and persist.
- Temporarily stop only our yt0-v2 unit to avoid competing request gates, and restore it with an EXIT trap.

## Comparisons

Paired runs at 1 request/second and 0.25 requests/second. Eight fixed English/US queries cover rare words, broad and narrow camera filenames, exact filename phrases, and a niche phrase. Repeated-query overlap is measured; no daily-throughput or long-term reliability inference is justified by this small sample.

## Hypotheses

1. Rare terms / exact filename phrases produce more explicit eligible zeros than broad popular-topic queries.
2. Narrow date slices improve the long-tail result mix, but may return fewer cards.
3. Sequential slower pacing may reduce transport failures compared with the prior four-worker pattern. Capture actual native error causes; do not mistake a failed transport for a zero result.

## Artifacts

`autoresearch.sh` runs `benchmark.mjs`. Each trial appends to `autoresearch.jsonl`; `summary.json` records the budget, completed trials and aggregate outcome. Only hashed video identities and minimal label/age evidence are saved, not titles, descriptions or database rows. Helpers have regression tests in `test/search-evidence.test.ts`.

## Results and keep/revert decisions

The first 16-request paired run completed without HTTP/transport failures. A one-request diagnostic found an age-parser defect: the live label was `1y ago`. Compact labels are now regression-tested; `m` is never treated as months. The initial eligible-zero counts are therefore not used to rank strategies.

A corrected eight-request follow-up at 0.5 requests/second tested specific filenames, another rare term and two known-channel catalogues. Two distinct observations qualified: one narrow rare-term result and one `MVI_2379` result. Channel-catalogue results remain inconclusive because the conservative reader did not support the modern count-field layout. Total live budget used: 24 benchmark requests plus one diagnostic.

Keep compact-age parsing and the separately labelled evidence class. Expand the promising query families in a larger trial; do not generalize the sample to daily yield. Do not claim slower pacing fixed production networking: both initial rates succeeded and the concurrent production failures were not reproduced here. Nothing was promoted to the numeric-verified archive.

See [REPORT.md](REPORT.md), the append-only per-trial JSONL and the final summary. For the follow-up plan, run `bash autoresearch.sh --followup` only after coordinating the application's request gate as described above.
