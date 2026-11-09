# Consistency-first search pacing

Updated: 2026-10-29.

## User goal

Run unattended24/7 with steady archive growth and automatic recovery, rather than maximum request throughput. No reset of source/global cooldowns, archive changes, account/CAPTCHA workflow or V1 modifications.

## Implemented and deployed

Release **20261029T091643Z**, SHA-256 **0142921c4d354b8c9622eed2e1b55718287b88b87602080e7c6e0f309d393cbe**.

- Search starts at most once every60seconds by default, including redirects. Its separate request deadline is persisted in SQLite, while RSS/catalogues retain the existing shared1rps gate.
- One search-dependent task lease prevents deliberately slow searches from occupying every worker. Cached metadata/proof and independent channel work remain runnable; idle exploration respects the same lease.
- Per-hop HTTP timeout starts after deliberate pacing waits, so a60second wait does not create a20second transport timeout. Caller cancellation still interrupts waiting and transport.
- Private status exposes searchNextRequestAt; existing minute status logs and daily counters permit a24-hour follow-up without another permanent monitoring service.

Configuration: SEARCH_REQUEST_INTERVAL_SECONDS=60. Existing SEARCH_PAGES=2 and durable job progress were unchanged. Production overrides were absent; runtime confirmed the default.

## Regression evidence

104 tests and TypeScript passed locally and on Linux Node24.17; production npm audit found no vulnerabilities. Nine new cases cover configuration bounds, concurrent spacing, restart persistence, dependency-aware claims, exclusive leases across connections, non-spinning exploration, redirect timeout semantics, unchanged backoff and cancellation. Earlier mocks were adjusted to model cached-eligibility concurrency instead of requiring concurrent search-dependent work.

## Live observation

-09:18UTC: validated all210 archive records (literal RSS zero, seven-day age at observation, identity and positive duration). Archive rows, all task rows and all private metadata matched the pre-switch backup exactly before startup.
- Existing search pause until09:19:45.529UTC remained intact. Search resumed automatically at09:19:46.339UTC, not by operator reset.
-21 read-only snapshots from09:19:15.649 to09:24:56.927 span341.278seconds, including SSH overhead. They observed six search200s, three completed two-page search jobs, no new redirect/failure, no new archive record, and at most one leased search job.
- Measured consecutive HTTP start intervals:60001,60297,60002,60168,60002milliseconds. Starts are derived from the persisted next-request deadline minus the configured60000milliseconds, and agree with search response counters.
- By09:27:33UTC, eight search200s and one independent RSS200 had occurred since the pre-switch snapshot, with no added task errors or redirects. The RSS run occurred before the sampler's first frame. Archive remained210; no discovery gain is claimed from this short window.
- Crawler, socket and forwarder active; crawler enabled, zero automatic restarts. Trusted public HTTPS/gallery/API returned200; operational status/health stayed public404.

## Final checkpoint

At 09:33 UTC there had been 14 successful search responses and one independent RSS response since the switch, no additional redirects/task errors, and no active source pause. Nine runtime/gallery hashes matched local source. All 210 prior archive rows remained byte-identical and the necessary preference was unchanged. `/var/backups/yt0-v2/post-steady-20261029T093318Z.sqlite` passed integrity checking. Service/socket/forwarder remained active; crawler enabled with zero automatic restarts. No new numeric record was found during this short check.

Markdown validation checked 20 files and 285 relative links with no unexpected missing targets; the known removed-guide link in append-only history was excluded.

## Decision and remaining uncertainty

Keep the gentler independent pacing: real automatic resumption and minute spacing are demonstrated. This does **not** establish sustained discovery yield or prove that challenges are solved. Compare daily verified discoveries and time spent paused over at least24hours; YouTube can still challenge, change or limit public interfaces. Existing journal status logs and metrics continue automatically.

## Artifacts

- [Read-only observer](observe.sh) and [21 raw aggregate snapshots](observations.jsonl); observer exited after its finite run.
- [Deployment/state/source evidence](../../../raw/2026-10-29-consistency-pacing.md).
- [Previous bounded batch experiment](../throughput-2026-10-26/REPORT.md).
- [Current operations](../../deploy/PRODUCTION.md).
