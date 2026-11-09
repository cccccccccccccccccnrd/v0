# Discovery-efficiency build

Updated: 2026-11-01

## Outcome

**Release `20261031T120412Z` produced 490 records in its first full 24 hours, versus 18 in the preceding 24 hours (about 27× observed).** At November 1 17:31 UTC, archive **892**, up **644 in 29h26** since rollout; latest rolling 24 hours **411**. Multi-day sustainability and isolated causality are not established. [Full-day evidence](../../../raw/2026-11-01-efficiency-day-one-report.md). All 111 tests passed again locally and on Linux; local TypeScript passed. Production restarted healthy with 248 archive rows preserved and RSS evidence invariants checked. [Deployment and observation evidence](../../../raw/2026-10-31-efficiency-deployment.md).

Read-only production aggregates showed **194/232 records credited to channel jobs**. Search history was heavily skewed: archive 2,611 runs / 21 credited records, older 632 / 17, recent 545 / 0. Thirty-three productive searches accounted for all 38 search-credited records; 7,290 other search jobs had none. Counts span releases, use successful task runs rather than actual HTTP denominators, and do not isolate channels' original discovery queries. [Full evidence](../../../raw/2026-10-30-discovery-efficiency.md).

## Deployed changes

| Change | Before | After | Evidence limit |
| --- | --- | --- | --- |
| Equal base search priority; preference for due queries with verified yield | Cold archive jobs beat productive older queries; first 30 fixture claims all archive | Productive query wins; balanced fixture gives 10 claims per band | Removes absolute band bias, not guaranteed production round robin or better yield |
| Bounded same-creator RSS reuse | 15 fixture checks → 15 feed requests | Same 15 qualifying checks → 1 feed request | Request saving for a fixture, not a live 15× discovery gain |

Implementation: [store.ts](../../store.ts) `seed`, initialization and claim order; [provider.ts](../../provider.ts) `readFeed`/`verify`. Feed observations retain their original timestamp, expire after 60 seconds, and occupy at most 64 creator slots. Failed/404 requests are not cached; known pre-cutoff observations are refreshed. Archive eligibility, positive-count rejection, backoff, exclusive search leases and minute spacing are unchanged.

Cold scheduling micro-check with all 7,023 bundled jobs: first 100 claims split 34 recent / 33 older / 33 archive. Local in-memory median claim 2.197 ms, p95 2.261 ms. Existing deadlines/progress/errors survive priority normalization. [Regressions](../../test/discovery-efficiency.test.ts).

## Live query pilot: no winning family

Ran before the fixes on the local host, at existing one-minute search spacing. Four search pages plus two RSS feeds used **6 actual requests**, all HTTP 200, out of a 16-request ceiling. The two creator feeds produced **zero qualifying numeric observations**. No archive records were inserted.

- Narrow archive `abstemious`: 20 cards, one zero hint.
- Narrow older `IMG`: 18 cards, no zero hint.
- Exact `MVI_2379`: 20 cards, one zero hint.
- Older exact `IMG_0487`: three cards, no zero hint.

Do not expand these families based on this sample or confuse search hints with numeric proof. YouTube's [documented relevance/engagement ranking and indexing delay](../../../wiki/sources/youtube-search-help.md) motivate query experiments, not a guarantee of coverage.

## Validation and operation

- **111 tests pass** on local Node25.1 and Linux Node24.17; local TypeScript passes. The research tests used a private temporary directory and existing dependencies, not live state; the October 31 rollout repeated all 111 tests in the staged release before switching.
- Seven new cases cover priority/upgrade preservation, shared feeds, expiry, pre-cutoff refresh, failed waiters, creator bounds and unknown evidence. Four regressions were observed failing before implementation.
- [Benchmark](benchmark.mjs) `--self-test` passes offline. `--live` is opt-in, limited to four searches/four creator references, 16 actual requests and six minutes, with durable experiment cooldown state. It stops on failures or active source/global pauses and never writes archive records. Do not launch it just to document it. Its HTTP daily summary is cumulative experiment-state data, not necessarily one invocation's counts.
- [Pilot observations](observations.jsonl) contain aggregates and public queries, not video records or credentials.

The October 30 research run made no production changes. The user subsequently authorized deployment on October 31: release `20261031T120412Z` is now active/enabled, with integrity-checked pre-switch backups and the previous release retained. Upgrade rehearsal preserved archive rows, queue progress, private metadata and cooldowns; live checks preserved all 248 old rows and evidence rules. No V1 changes, dependency installation, commits or pushes. No fresh audit or restore drill. A first full-day additions comparison is now available below; multi-day stability and total paused time remain unverified.

## Initial rollout observation (October 31)

Release `20261031T120412Z` ran healthy throughout six passive snapshots from 12:06:17 to 12:11:17 UTC. Five search HTTP 200s plus one RSS HTTP 200 used six actual requests; three search runs completed, two candidates were queued, and no task errors or active pauses appeared in the sample. Archive stayed **248 → 248**, so no live yield improvement is claimed. Older-band successful runs rose 632 → 635; other bands were unchanged, not live round robin. Pre-rollout baseline: **18 additions in the preceding 24 hours**. [Aggregate observations](deployment-2026-10-31.jsonl) and [full deployment evidence](../../../raw/2026-10-31-efficiency-deployment.md). Compare at least 24 hours before judging discovery yield.

## Production follow-up: 18:39 UTC

Archive **248 → 523** in **6h34**, about **41.8 additions/hour** observed, versus seven additions in the immediately preceding equal-duration interval. Records span 51 creators and multiple hours (hour buckets: 52, 39, 67, 69, 3, 32, 13; first/last partial). Credit: 255 channel jobs, 20 searches. This is not a single-creator burst, but neither 39× sustained throughput nor a daily forecast is established. All 248 old archive rows remained byte-identical. Service healthy, zero automatic restarts, no active pause at check; five task errors and one throttled event occurred across 537 actual requests. No new probes, runtime changes or evidence revalidation. [Full read-only comparison and limitations](../../../raw/2026-10-31-efficiency-follow-up.md).

## First full day and 29-hour checkpoint (November 1)

At **17:31:53 UTC**, archive **892**, **+644 in 29h26**, spanning 119 creators. First post-rollout 24 hours: **490 additions** versus **18** in the previous 24 hours; latest rolling day: **411**; latest six hours: **168**. All 248 old archive rows remained byte-identical. Final task credit: 586 channel jobs, 58 searches.

Growth by deployment-anchored six-hour blocks: **262, 111, 0, 117**, then **154** in the partial fifth block. The no-addition interval is not a proven outage; its cause and total paused time were not investigated. Current service healthy with zero automatic restarts; 28 task errors and three throttled events across 2,479 requests since rollout. Public root 200/private status public 404. No runtime changes, fresh tests, integrity scan or evidence revalidation. The adjacent-day result is strong observed improvement, not a controlled causal estimate or multi-day guarantee. [Full report](../../../raw/2026-11-01-efficiency-day-one-report.md).

## Sources

- [November 1 first full-day production report](../../../raw/2026-11-01-efficiency-day-one-report.md).
- [October 31 18:39 UTC production comparison](../../../raw/2026-10-31-efficiency-follow-up.md).
- [Authorized deployment and initial monitoring, October 31](../../../raw/2026-10-31-efficiency-deployment.md).
- [Request, production aggregates, reproduction and validation](../../../raw/2026-10-30-discovery-efficiency.md).
- [Earlier consistency-first release](../steady-2026-10-29/REPORT.md) and [production operations](../../deploy/PRODUCTION.md).
- [Primary search-ranking documentation capture](../../../raw/2026-10-30-youtube-search-help.md).
