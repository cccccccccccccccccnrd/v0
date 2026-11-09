#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
ssh -o BatchMode=yes -o ConnectTimeout=10 cnrd@x.c-e.group /usr/bin/node --input-type=module <<'JS' | tee -a autoresearch.jsonl
for(let sample=0;sample<=10;sample++){
  const response=await fetch('http://127.0.0.1:3667/api/status');
  if(!response.ok)throw new Error('Status request failed');
  const status=await response.json();
  console.log(JSON.stringify({time:new Date().toISOString(),archive:status.videos,queue:status.queue,metrics:status.today,sourcePauses:status.sourcePauses,globalPauseUntil:status.pauseUntil}));
  if(sample<10)await new Promise(resolve=>setTimeout(resolve,30000));
}
JS
