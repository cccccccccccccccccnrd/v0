# Bounded collection-throughput optimization

Started: 2026-10-26; continued 2026-10-27. User requested finding eligible zero-view videos faster.

## Objective and budget

Primary goal: new numeric-verified seven-day-old zeros per actual HTTP request and elapsed time, without weakening evidence or bypassing access controls. Preserve the archive, all CSV terms, durable job progress, public original frontend and V1.

Use existing production pacing (1 request/second), with every redirect counted/paced. Live observation is limited to a five-minute sampler after deployment; no extra YouTube probe traffic. Respect existing global/source deadlines. Synthetic/local tests exercise failures without platform requests. The live creator pilot advances three healthy productive jobs, followed by at most eight healthy lower-archive-count creator jobs, using the same actual-request gate; no failed/backed-off job is forced.

Baseline at 21:51 UTC: archive157,7235search jobs; today's counters7860outer requests,973network errors,2395search runs. These old request totals omit automatic redirect hops, so their ratio is not directly comparable to the new per-hop counter.

## Hypotheses

1. Excessive automatic redirects waste up to21HTTP exchanges per counted outer operation. Manual bounded/cycle-aware per-hop handling should stop self-loops after1request, cap nonrepeating chains at4requests and preserve real denial/Retry-After behavior.
2. A later failed search slice currently discards successful earlier results. Preserving partial candidates should avoid losing useful work without suppressing errors/backoff.
3. Verification with cached eligibility/evidence should not wait for sources it will not call. Dependency-aware claims should allow this work while actual network gates still protect unavailable sources.

Record exact redirect categories/hosts and changed parameter names only; never values, cookies, credentials, raw bodies or database rows. Consent/login/challenge destinations are not followed or solved.

4. Batch public-channel eligibility can replace individual ID searches. Bind catalogue ownership and match video IDs; numeric proof/age always remain RSS-derived. Regression:15eligible fixture videos use2requests, not16. Fresh complete evidence may supersede unknown cache and upgrade unleased jobs without changing their original source/query lineage.

## Authorized consent step

A real catalogue request redirected to YouTube consent and was stopped. The user then explicitly authorized the ordinary Reject-all action and retaining only necessary preference. The actual renderer's Reject-all endpoint accepted POST204 and issuedSOCS. Only that preference is privately stored and narrowly sent to HTTPSwww.youtube.com; account/tracking cookies, rawmessages/URLs and temporarytokens are not retained. Existing search/catalogue/global deadlines were preserved. Genuine verification challenges remain blocked.

Baseline immediately before the consent-enabled deployment:172verified records. Successful metadata responses and new archive deltas, not test counts or service heartbeat, determine measured improvement.

## Session artifacts

`autoresearch.sh` records a read-only five-minute status sample; results append to `autoresearch.jsonl`. Keep/revert decisions and observed outcomes will be recorded after validation. The original 69-test release remains available for rollback. No source backoff is cleared to force a benchmark.
