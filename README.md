# yt0 V2 — continuous zero-view discovery

A Node.js crawler and archive browser for videos observed at **exactly zero views**, **at least seven days after upload**.

**No official YouTube Data API, API key, account login, identity rotation, or media downloads.** The user authorized the ordinary Reject-all consent choice: only its necessary server-issued `SOCS` preference may be kept privately and sent to HTTPS `www.youtube.com`; no account/tracking cookies are retained. Public search HTML discovers videos and channels without private API calls; verification reads the literal numeric count in channel RSS and matches non-live public search or channel-catalogue metadata. No `/player` request is required. Public endpoints can still throttle, block, or change. This is not unlimited access or a complete index of YouTube; applicable platform terms still matter.

V1 in `../src/arranging-data-into-lists/` is untouched. V2 has its own database and port.

This is the engine behind the artwork [Arranging Data Into Lists](https://cnrd.computer/#arranging-data-into-lists). In the public repository, the earlier Deno version is kept at tag `v1-deno-2025`. Links to `../raw/` and `../wiki/` point to the private research wiki this code is developed in. The artwork card's Aston Script font is commercial and not included; without it `/v2-script.ttf` returns 404 and the card title falls back to Arial.

**Public website: https://yt0.cnrd.computer/** — the /v2 search space, with the original black gallery at `/v1`, backed by V2's historical archive. https://yt0.c-e.group/ redirects there. The crawler dashboard remains private.

## Discovery measurement stage

Release `20261106T000215Z` was deployed November 6 after explicit approval, 127 passing local/Linux tests, integrity-checked backups and archive/cooldown preservation checks. [Deployment evidence](../raw/2026-11-06-measurement-deployment.md). The measurement build leaves scheduling credit, request limits, eligibility and archive retention unchanged. `/api/status` remains private and adds `measurementStartedAt` plus mutually exclusive `waits` counts: leased, young, scheduled, global backoff, source/dependency wait, normal search pacing, verification capacity or ready. These are snapshots, not measured elapsed durations; a leased task is not necessarily making a network request. Source/dependency wait can mean the exclusive search lease, not an active source pause.

New daily metrics begin at `measurementStartedAt`, not at the beginning of a partly observed UTC day:

- `requests_keyword`, `requests_metadata`, `requests_rss`, `requests_catalogue`, `requests_search_unclassified`, `requests_other`: actual transport attempts, including redirects and failed attempts, never cache hits or deliberate cooldown waits. All normal provider search calls distinguish keyword slices from exact-ID metadata lookups using async-local context, not outbound headers.
- `response_PURPOSE_STATUS`, `request_error_PURPOSE`: responses and transport errors by purpose. `feed_response_STATUS` is an additional creator-keyed dimension for RSS, not extra HTTP traffic; do not sum it with request totals.
- `rss_cache_miss`, `rss_cache_reuse`: provider cache/coalescing events, not actual HTTP counts. A miss may still be deferred by backoff. No caching/retry policy changed.
- `verification_REASON`: provider decisions such as verified, young, missing card/RSS entry/evidence, positive hint/count, missing duration or unavailable. `verification_already_archived` is a no-request short-circuit. Existing `checks_STATUS` and task errors remain; `task_error_KIND` adds per-source failure accounting.
- `root_attributed_zero`, `root_unattributed_zero`: newly saved records only; no historical evidence/credit rewrite.

`source_metrics(day,key,name,value)` retains 90 days of per-job request/outcome counts and creator-keyed `feed_response_STATUS` events. `source_lineage(key,root_key,parent_key,first_seen)` retains first-observed source associations; repeated admission or queue upgrades do not replace them. New title terms/creator jobs inherit known parents. Existing searches become baseline roots when first observed; existing creators with unknown ancestry and their descendants stay unattributed. This is post-rollout first-touch association, not reconstructed historical provenance or proven causality. Root credit is stored as `root_verified_zero` in source metrics and does not change `tasks.found`, search priority or original archive rows.

For a read-only report after at least 24 hours, group `source_metrics` by day/name to split purpose cost; group `feed_response_404` by creator key to identify repeat misses; join source metrics to `source_lineage` on `key` and group by `root_key` for associated downstream request cost. Exclude `feed_response_*` from root cost totals (it is a second dimension), count only `requests_*`, and use `root_verified_zero` for root additions without double-counting immediate `verified_zero`. Never print private state, credentials or individual archive records into reports. The measurement schema is additive; the retained previous runtime can ignore the new tables for rollback.

## Standalone snapshot dashboard

Open [dashboard.html](dashboard.html) directly in a browser. One self-contained black/white HTML file, using native tables and lists, with a filterable top-30 learned-term table and approximate English translations. Snapshot: **November 2, 07:24 UTC**; **1,021 archived**, 366 added in the last 24 hours, three in the last six hours. It does not auto-refresh or have a served app route; it is included as an offline reference in the November 6 release package. Existing live gallery/private dashboard and crawler are unchanged. The page now includes [archive retention](dashboard.html#retention) and the [full qualification checklist](dashboard.html#qualifications), reviewed November 3. The November 4 [search flowchart](dashboard.html#search-flow) explains keyword discovery, recurring channel RSS/catalogue checks, shared verification and feedback; all dashboard text uses normal font weight. The suite now passes 127 tests locally and on Linux, including five artifact checks and eleven measurement cases; production uses the measurement build. [Flowchart source review and browser checks](../raw/2026-11-04-search-flowchart.md). [Original build](../raw/2026-11-02-dashboard-build.md) and [qualification update](../raw/2026-11-03-retention-qualifications.md).

## Start locally

Requires **Node.js 24.12.0+** and npm. No build step, Python, Deno, Redis, or external database.

```sh
cd V2
npm ci
npm run check
npm test
npm start
```

Open **http://127.0.0.1:3667**. One process runs the browser/API and asynchronous workers. Optional configuration goes in `.env`; use `.env.example` as a reference without overwriting an existing configuration.

The archive, queue, cursors, cooldowns, and counters live in **`data/yt0.sqlite`** unless `DATA_DIR` is set. Stop with Ctrl-C; restart with the same data directory to resume. Smoke-test discoveries have been preserved in the local V2 database.

## Deployed efficiency build

The [October 30 efficiency build](experiments/yield-2026-10-30/REPORT.md) was deployed on October 31 as **`20261031T120412Z`**. It removes absolute archive-band priority, prefers due queries with real verified yield, and shares same-creator RSS observations for up to 60 seconds (64-creator bound). The 15-video fixture uses one feed request instead of 15; all 111 tests pass locally and on Linux, with local TypeScript checks. Production restarted healthy with all 248 prior archive rows preserved and evidence-checked; pacing, backoff, consent and evidence rules remain unchanged. At **November 1 17:31 UTC**, production held **892 archived**, **+644 in 29h26** since rollout. First post-rollout 24 hours yielded **490 additions versus 18** in the previous day; latest rolling day **411**. The service remained healthy with zero automatic restarts, but growth included a six-hour no-addition interval. Strong first-day observed output is not a controlled causal or multi-day guarantee. [Full-day report](../raw/2026-11-01-efficiency-day-one-report.md). See [deployment evidence](../raw/2026-10-31-efficiency-deployment.md).

## Why this should spend requests better

The objective is **steady daily archive growth and automatic recovery**, not maximum HTTP traffic. Search starts at most one actual HTTP request per minute by default, including redirects; its next-request deadline survives restarts. Only one search-dependent job holds a lease, leaving other workers available for RSS, catalogues and cached verification. Existing denial/backoff deadlines are never shortened.

1. **RSS-first verification.** Searches discover candidates and admit up to three distinct channels per job only from explicit-zero hints or verified discoveries. RSS supplies numeric counts for multiple videos in one request. A matching public card supplies static-video eligibility and duration. A channel catalogue can supply these for an entire RSS batch in one HTML request, avoiding one search per video; it is skipped when every old-enough RSS zero is already archived. One shared request gate paces every actual request. Matching feed requests/observations are reused for at most 60 seconds across 64 creators, retaining the original check time; failures are not cached, and known pre-cutoff zeros require a fresh observation.
2. **Do not paginate forever.** Default: two distinct public-HTML date slices per search, not private API continuations. Search cards are only hints. Explicit-zero cards go first; known-positive cards are skipped; one rotating unknown-count candidate is sampled per job.
3. **Rotate date shards.** Each seed gets recent, older, and historical jobs. Narrow date slices apply from the first pass, rotating 1-day, 7-day, and 30-day slices respectively:
   - recent: 7–37 days old;
   - older: 37–187 days;
   - historical: 187 days back to 2005.
   Search operators are hints, not proof of age; the metadata check enforces the cutoff independently.
4. **Spend search slots on yield and breadth.** Due searches with verified discoveries have a small preference; cold age bands share base priority rather than always draining archive queries first. Deadlines and source gates still apply. If no due work exists, the scheduler advances an unvisited shard instead of sleeping until a redundant broad search. It respects failure backoff, queue backpressure, and a cooldown after a complete shard pass.
5. **Protect the productive source pool.** Positive cards do not seed RSS jobs. Empty sources are retired and temporarily suppressed, while archived creators and pending candidates remain protected. Channels are polled every 12 hours, or six hours after verified yield. Verified videos also add up to two title-derived exploration terms.
6. **Keep early candidates without inventing future proof.** Young RSS candidates wait in the durable queue until seven days old. Their counts must then be fetched again; an early zero never becomes an eligible observation just by waiting. RSS's limited recent entries can still age out before the cutoff. Query revisit timing adapts to yield; source selection remains heuristic.
7. **Deduplicate before fetching details.** Archived IDs are never automatically reverified. Nonzero/positive-hint IDs are cached for seven days; unknown/unavailable results for one day, subject to seen-cache retention.

The portable seed file contains all **2,220 words** from the user-supplied [Domain-Specific-Word-List CSV](https://github.com/FarahAlshanik/Domain-Specific-Word-List/blob/ab8a90e66f14fe6e7137687e1ac94deb9d49df05/words.csv), plus the original filename/topic/multilingual terms: **2,341 distinct terms**, or **7,023 age-band jobs** on a fresh database. Only the first column is used; numeric scores are not search text, and `010` remains a string. The CSV is pinned rather than fetched on every boot. No arbitrary 500-entry skip remains. Add your own phrases—especially names/patterns from genuinely low-visibility material:

```sh
npm run seed -- /absolute/path/to/terms.txt
```

One phrase per line; blank lines and `#` comments are ignored. Repeated seeds are idempotent. Caps bound the active query/channel population; raise them deliberately if you want more breadth. At the cap, existing jobs continue but additional sources are not admitted.

## What “verified zero” means

New RSS records require the **literal `views="0"` attribute** at `media:group/media:community/media:statistics`, an exact video/channel match, and a valid publication timestamp at least seven days before the RSS observation. Missing, encoded, padded, rounded/display, or malformed counts do **not** qualify. Counts and check time are preserved in evidence as `youtube/rss`, `media:statistics/@views`, and raw string `"0"`.

RSS does not supply reliable duration or live/upcoming flags. A matching public search or channel-catalogue card with a positive, valid duration and no live/upcoming markers is therefore required. Catalogue ownership is bound to its requested channel before card metadata can be used. A contradictory positive search hint rejects the candidate. Missing eligibility information remains unknown, never a verified zero. Date-only metadata waits through the end of its UTC day before applying seven days.

Eligible feed observations may be reused from queued work; observations made before the age cutoff must be refreshed afterward. Previously archived `innertube/player` evidence remains valid historical data, but the new collector makes **no player endpoint requests**. Playback is not tested, and access challenges are not bypassed.

The record keeps the literal zero evidence and check time. **The archive is historical. Counts are not refreshed after discovery, and videos are not removed when they gain views.** Clicking/watching through the gallery does not remove the entry or overwrite its original zero evidence. There is no automatic archive age expiry; filters/pagination only affect what is displayed. The archive stores metadata/evidence, not downloaded videos, so later YouTube deletion/privacy changes can still prevent playback. The seven-day minimum is 168 hours at observation, not an expiry window; see the [full current checklist](dashboard.html#qualifications). The crawler does not play videos or send playback-tracking requests.

## Long-running safety

- SQLite WAL with `synchronous=FULL`; indexed keyset browsing and transactionally maintained archive/queue counts.
- Atomic job claims, unique keys, lease tokens, 30-second renewals, and two-minute lease expiry for crash recovery.
- Graceful shutdown aborts requests and releases interrupted work without treating normal cancellation as failure. A queued acknowledgement left behind an already committed archive record is completed without fetching it again. Hard crashes can still repeat a request whose result was never committed; external requests are not exactly-once.
- Network timeouts, streamed response bodies capped at 8 MiB, bounded workers/pages/queues, and backpressure.
- Retry-After handling, jittered exponential retries, persisted global cooldowns for HTTP 403/429, plus independent search/channel/verification failure circuits. HTTP 5xx, network and parser failures are attributed to their source, including when reached through a verification job. Source pauses are visible in status/UI; the existing global cooldown is not cleared by upgrades.
- Young candidates wait for the age cutoff; unavailable metadata never becomes zero.
- Seen-cache retention and 90-day metric retention bound operational history. Verified archive records are never pruned.
- A free-space check pauses collection for an hour when less than **512 MiB** remains. This protects writes; it does not create storage.
- Per-source HTTP status counters expose unavailable feeds (for example `http_channel_404`); the UI explicitly warns about RSS 404s rather than presenting them as zero-view evidence.
- No obsolete scraper dumps or full raw metadata responses are written to disk.
- The HTTP interface is read-only, loopback-only by default, bounded/paginated, and protected with a CSP. No public queue-control endpoint.

Run **one V2 process per data directory**, with SQLite state on local disk rather than NFS/shared network storage. Claims are safe across connections, but the request pacing gate is process-local; this is not a distributed multi-server crawler. V1 or other crawlers on the same outbound IP also consume that host's access budget.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3667` | Bind address; put a reverse proxy in front for remote access. |
| `DATA_DIR` | V2's `data/` | Persistent state, separate from V1. |
| `WORKERS` | `4` | Concurrent jobs, not requests per second. |
| `REQUESTS_PER_SECOND` | `1` | Shared outbound request pacing. |
| `SEARCH_REQUEST_INTERVAL_SECONDS` | `60` | Minimum interval between actual search HTTP starts; independent sources retain shared pacing. |
| `REQUEST_TIMEOUT_MS` | `20000` | Per-HTTP-hop timeout including body consumption, excluding deliberate pacing waits. |
| `SEARCH_PAGES` | `2` | Maximum distinct public-HTML date slices per job. |
| `MAX_PENDING` | `20000` | Pending verification ceiling. |
| `MAX_SEARCHES` | `10000` | Active search-job ceiling; fits the complete bundled word list and three age bands. |
| `MAX_CHANNELS` | `2000` | Active channel-job ceiling. |
| `SEARCH_INTERVAL_HOURS` | `6` | Base revisit interval; yield/backoff and shard exploration adjust it. |
| `SEEN_TTL_DAYS` | `30` | Non-archive seen-cache retention. |

Start conservatively. More workers help hide network latency; they do not bypass the request gate. Increase request rate only while monitoring verified-zero yield, latency, failures, and upstream responses. Do not defeat cooldowns. No throughput or ban-free-operation guarantee is possible.

## Original frontend and public routing

`public/site.html`, `site.css` and `site.js` retain V1's original gallery identity without modifying V1. Locally preview it at **http://127.0.0.1:3667/site/**; the existing dashboard remains at `/`. Filtering covers loaded pages, with cursor-based infinite/load-more browsing and retry without skipped pages. Metadata is rendered as text and links/images use validated, fixed YouTube origins. There is no autoplay or embedded player.

On xceg, shared Traefik exposes only the original gallery assets and bounded `/api/videos`, with HTTPS and request limiting. Status, health and dashboard routes remain private. A bridge-only systemd socket connects Traefik to the loopback backend without opening the backend on a public interface. See [production routing and recovery](deploy/PRODUCTION.md), [route](deploy/yt0.yml), [socket](deploy/yt0-public.socket), and [forwarder](deploy/yt0-public.service). Route configuration uses JSON syntax (valid YAML) so it can be checked by Node without an added parser package.

## Linux / systemd

The installation on **`xceg` (`cnrd@x.c-e.group`)** keeps this backend unit private; the separate public gallery uses the routing described above. The supplied unit expects:

- code and production dependencies under **`/opt/yt0/V2`**, readable outside your home directory;
- a **system-wide Node 24.12.0+** at **`/usr/bin/node`**—adjust `ExecStart` if your system-wide path differs;
- private state in **`/var/lib/yt0`**, managed by `StateDirectory=yt0` with mode `0700`;
- automatic restart, a 768 MiB soft memory limit and a 1 GiB hard limit.

Do not use a private NVM executable in a home directory with `ProtectHome=yes`.

After copying the code to the server, install its locked production dependencies there:

```sh
cd /opt/yt0/V2
npm ci --omit=dev --ignore-scripts
node --version
```

Optional overrides go in `/etc/yt0-v2.env`:

```ini
DATA_DIR=/var/lib/yt0
WORKERS=4
REQUESTS_PER_SECOND=1
SEARCH_REQUEST_INTERVAL_SECONDS=60
SEARCH_PAGES=2
```

Keep `DATA_DIR` absolute; do not accidentally replace it with the local example's `./data`.

Install and start the supplied unit:

```sh
sudo install -m 0644 deploy/yt0-v2.service /etc/systemd/system/yt0-v2.service
sudo systemctl daemon-reload
sudo systemctl enable --now yt0-v2
sudo systemctl status yt0-v2
```

**Live crawler log:**

```sh
sudo journalctl -u yt0-v2 -f -o cat
```

Useful events: `zero_found`, `search_complete`, `channel_complete`, `task_failed`, `network_error`, `status`, `low_disk`.

`network_error` records validated native error codes, bounded causes, fixed known reasons, timing and cancellation without logging raw messages, query URLs or credentials. Normal requests have exposed `redirect_limit` failures: native fetch exceeded its 20-redirect cap. Redirects are now manual, cycle-aware and capped at four actual requests; each hop is paced/counted. Cross-origin or credential-bearing redirects are not followed. Consent/login/verification redirects trigger backoff, never an automated bypass. Later search-page failures preserve earlier candidates, and cached verification only waits on sources it still needs. See [diagnosis evidence](../raw/2026-10-26-native-fetch-diagnosis.md). Our events are JSON; library/runtime diagnostics may also appear on stderr. Journald handles rotation according to the host's retention settings; configure an appropriate host disk budget.

```sh
curl --fail http://127.0.0.1:3667/healthz
curl --fail http://127.0.0.1:3667/api/status
```

Private status exposes `searchNextRequestAt` separately from access-denial pauses. Compare daily `verified_zero` and source error counts over24hours, not just service uptime. A persisted access cooldown is a healthy *paused* crawler, not a reason to restart-loop it. Reverse-proxy the loopback endpoint with HTTPS/access control if exposing it beyond the server.

The unit restarts on exits and after boot. Hard crashes may leave leases that take up to two minutes to expire. Protect the state disk, monitor free space and discovery/error rates, and maintain the client dependency when YouTube changes. “Continuous” does not mean maintenance-free.

## Preserve and import V1

The importer never modifies V1. It supports a JSON stats export or a streaming read-only import from the Node V1 SQLite schema:

```sh
npm run import -- /absolute/path/to/export.json
npm run import -- --sqlite /absolute/path/to/V1/yt/videos.sqlite
```

Imports are transactional and idempotent. Legacy rows stay **explicitly unverified**, even if V1 reported zero. Their rechecks enter a bounded queue and are replenished as capacity becomes available. Only a new explicit-zero check promotes a legacy row to V2-verified. Legacy rows that no longer qualify are retained as unverified history, not deleted.

The old Deno KV format is not this SQLite schema; export it through the old API first. No Deno runtime is required by V2.

For the systemd state directory, run imports with `DATA_DIR=/var/lib/yt0` and suitable file permissions before starting the service. The unit manages state ownership. Do not point V2 at V1's database file.

## Back up and restore

Use SQLite's online backup, **not a raw copy of a live WAL database**:

```sh
npm run backup -- /absolute/path/to/new-backup.sqlite
```

The command opens its source read-only and refuses to overwrite an existing destination. For protected systemd state, an administrator can run:

```sh
sudo env DATA_DIR=/var/lib/yt0 /usr/bin/node /opt/yt0/V2/cli.ts backup /srv/backups/yt0-NEW-TIMESTAMP.sqlite
```

Choose a new filename each time. Verify backups and arrange off-host copies and retention with your server's existing backup tooling; backups must not fill the crawler's state disk. A failed backup can leave a reserved/partial destination—never treat it as valid merely because the file exists.

To restore, stop the service, restore the snapshot as `yt0.sqlite` into a **new** state directory, and update both `StateDirectory` and `DATA_DIR` consistently. Verify health and archive counts before retiring the old state. Never overwrite live state or copy only the main file while its WAL writer is active.

## API and compatibility

- `GET /api/videos?limit=50&cursor=…` — keyset-paginated records and next cursor; max 200.
- `GET /api/status` — counts, queue, daily metrics, recent job errors, cooldown, heartbeat.
- `GET /healthz` — heartbeat/readiness; 503 during stopping or when stale.

V2 does **not** preserve V1's unbounded `/yt/0/stats` response or its rotating playback endpoint/Android helper. The original gallery has been adapted to the bounded V2 API; V1 remains separate for old callers. There are no HTTP mutation endpoints.

## Evidence and limitations

The regression suite covers literal RSS counts/provenance, the complete search→RSS→archive path without player requests, conservative eligibility, young-count refresh, modern/live cards, independent persisted circuits, and the original queue/HTTP/backup/lifecycle guarantees. Run `npm run check && npm test` for the current total. The original 38-test suite also passed on Node 24.12.0, 24.17.0 (Linux), and 25.1.0; npm audit reported zero known vulnerabilities on 2026-10-25.

A local bounded live run saved 3 zeros from 25 requests; a resumed shard run used 15 further requests and added a fourth discovery. All were at least seven days old, with literal zero evidence. The first run used about 141 MiB RSS. A local in-memory queue check made 100 ready claims among 20,000 future jobs in 53.83 ms.

These are **small smoke/synthetic checks, not a sustained server benchmark**. No daily yield, universal coverage, permanent upstream compatibility, or multi-month uptime claim is made. Search indexing, terms, date-operator behavior, RSS's limited recent entries, candidate sampling, source caps, and an IP's access conditions all constrain coverage. High-frequency channels can age out of RSS before seven days.

The Linux unit, private SSH forwarding, online backup integrity, and restart persistence were exercised on `xceg`. The original player-based collector was blocked by a human-verification response; the RSS-first path avoids that endpoint and has now produced its first real verified discovery on `xceg`. Stored RSS provenance, literal zero, seven-day age and duration were checked independently through the private API. Many feeds still return 404/500, so availability and sustained yield are not guaranteed. The captured feed replay also parses all 15 entries correctly. See [production operations](deploy/PRODUCTION.md) and [the first live RSS validation](../raw/2026-10-26-rss-first-production-validation.md). By 2026-10-26 07:20 UTC, the public-search refactor had 53 numeric-verified RSS records; all passed read-only zero/age checks and were protected by an online backup. Earlier releases had intermittent transport-error source pauses; current health/throughput is recorded separately in the production runbook.

The user-approved search-reported tier was benchmarked separately: the corrected follow-up found two new-to-the-archive label observations in eight requests. They were not inserted as numeric-verified records. The experiment helper has local type checking and a 60-test passing suite, including compact ages such as `1y ago`. See the [query/pacing comparison](experiments/search-2026-10-26/REPORT.md). It is not yet a production reported-tier writer.

A long soak remains unchecked. Details: [wiki architecture and evidence](../wiki/v2.md).
