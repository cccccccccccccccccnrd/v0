# Bounded throughput optimization report

Updated: 2026-10-29. Experiment started 26 October and continued 27 October; this retrospective uses retained observations and session deployment outputs.

## Outcome

The batch path works, but no sustained speedup was established. Later user priority changed to **consistent daily growth**, addressed in the [steady-pacing experiment](../steady-2026-10-29/REPORT.md).

| Check | Actual HTTP requests | New numeric records | Interpretation |
| --- | ---: | ---: | --- |
| Eight-creator live pass | 16 | 1 | Mostly already-covered creators |
| Full consent-enabled observation phase | 30 | 1 | Includes the above creator pass and ordinary search traffic |
| Passive five-minute interval | 2 | 0 | One independent RSS/catalogue run while search remained paused |
| Final single-creator pass | 2 | 3 | Favorable batch, not a representative rate |
| Synthetic batch regression | 2 | 15 fixture records | Correctness/request-count evidence only |

The archive was172 before the consent-enabled release,173 after its first live pass, and176 after final validation. Earlier core fixes preserved157 records at09:26 on27 October; background collection had reached172 by22:05. These snapshots are not matched before/after throughput trials.

## Kept

- Manual cycle-aware redirects, four actual-request limit, per-hop counting/pacing and discarded-body cancellation.
- Earlier successful search pages retained when a later page fails; original denial/backoff still propagates.
- Verification gates only its missing dependencies; fresh complete proof can safely upgrade unleased work and unknown cache.
- RSS numeric proof plus identity-bound public catalogue eligibility, with separate catalogue/RSS circuits.
- User-authorized ordinary Reject-all preference; only necessary SOCS retained privately and narrowly sent to HTTPS www.youtube.com.
- Skip catalogue requests when every old-enough RSS zero is already archived. This branch is regression-tested; the final live creator unexpectedly contained new zeros, so that pass did not prove the skip branch.

## Measurement limits

The passive sampler ran22:15:40–22:20:40 UTC on27 October, after the main creator pass. Its11 snapshots span300.115 seconds; one channel run made RSS200 + catalogue200 and no discovery. It is not a five-minute active-search benchmark. See [observations](autoresearch.jsonl).

Search verification challenges continued. The creator samples were selected rather than randomized, coverage was heterogeneous, and counters span releases. No reliable long-run rate, unrestricted access or fixed platform availability follows. No source cooldown was cleared, benchmark label promoted into numeric proof, account used or CAPTCHA solved.

The final95-test suite/type checks passed locally and on Linux; production audit was clean. All173 records passed the full numeric/age/identity/duration check, prior172 rows were byte-identical, and the post-run176-record backup passed integrity checking. Service and public/private routing were verified.

## Provenance

- [Detailed dated optimization/consent capture](../../../raw/2026-10-27-throughput-optimization.md), including release checksums and snapshots.
- [Plan and hypotheses](autoresearch.md); [read-only sampler](autoresearch.sh).
- [Current runbook](../../README.md) and [production operations](../../deploy/PRODUCTION.md).
