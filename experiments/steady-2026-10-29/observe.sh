#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
for sample in $(seq 0 20); do
  ssh -o BatchMode=yes -o ConnectTimeout=10 cnrd@x.c-e.group node --input-type=module <<'JS' | tee -a observations.jsonl
const s = await (await fetch('http://127.0.0.1:3667/api/status')).json()
console.log(JSON.stringify({ time: new Date().toISOString(), archive: s.videos, queue: s.queue,
  metrics: s.today, sourcePauses: s.sourcePauses, globalPauseUntil: s.pauseUntil,
  searchNextRequestAt: s.searchNextRequestAt, heartbeat: s.heartbeat }))
JS
  if [ "$sample" -lt 20 ]; then sleep 15; fi
done
