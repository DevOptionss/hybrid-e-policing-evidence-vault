'use strict';
/**
 * Large file memory test (Objective 4, test 13 on its own).
 *   $env:LARGE_MB=500; node tests\large-file-test.js | Tee-Object evidence\large_file_output.txt
 * Creates a random file, ingests it, verifies it, and reports how much memory the server used,
 * split into total, JavaScript heap and buffers, so any growth can be traced.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';
const MB_SIZE = Number(process.env.LARGE_MB) || 500;
const MB = (x) => Math.round(x / 1048576);

async function api(p, { method = 'GET', headers = {}, json } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'X-Acct': 'officerA', 'X-Key': KEY, 'Content-Type': 'application/json', ...headers }, body: json ? JSON.stringify(json) : undefined });
  return r.json();
}

(async () => {
  const st = await api('/api/status');
  if (!st.ready) { console.error('The server is not ready.'); process.exit(2); }
  const file = path.join(os.tmpdir(), 'large-' + Date.now() + '.bin');
  const fd = fs.openSync(file, 'w'); const chunk = crypto.randomBytes(1048576);
  for (let i = 0; i < MB_SIZE; i++) { crypto.randomFillSync(chunk, 0, 4096); fs.writeSync(fd, chunk); }
  fs.closeSync(fd);
  console.log('File: ' + MB_SIZE + ' MB. Cloud tier: ' + (st.tiers.cloud.enabled ? 'on' : 'off'));

  const base = st.mem || { rss: st.rss, heapUsed: 0, arrayBuffers: 0 };
  const peak = { ...base }; let on = true;
  const poll = (async () => {
    while (on) {
      const s = await api('/api/status');
      if (s.mem) for (const k of Object.keys(peak)) if (s.mem[k] > peak[k]) peak[k] = s.mem[k];
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  const t0 = Date.now();
  const ing = await api('/api/media/ingest', { method: 'POST', json: { path: file, type: 'cctv', caseId: 'LARGE-' + MB_SIZE, fileName: 'large.bin' } });
  const t1 = Date.now();
  if (ing.error) { on = false; await poll; fs.unlinkSync(file); console.error('Ingest failed: ' + ing.error); process.exit(1); }
  const ver = await api('/api/media/verify', { method: 'POST', headers: { 'X-Id': String(ing.evidenceId) } });
  const t2 = Date.now();
  on = false; await poll; fs.unlinkSync(file);

  console.log('Ingest:  ' + ((t1 - t0) / 1000).toFixed(1) + ' s for ' + ing.segmentCount + ' segments (hash ' + ing.timings.hash + ' ms, encrypt ' + ing.timings.encrypt + ' ms, IPFS ' + ing.timings.ipfs + ' ms, replicate ' + ing.timings.replicate + ' ms, ledger ' + ing.timings.ledger + ' ms)');
  console.log('Verify:  ' + ((t2 - t1) / 1000).toFixed(1) + ' s, verified ' + ver.ok);
  console.log('Memory before: total ' + MB(base.rss) + ' MB, heap ' + MB(base.heapUsed) + ' MB, buffers ' + MB(base.arrayBuffers) + ' MB');
  console.log('Memory peak:   total ' + MB(peak.rss) + ' MB, heap ' + MB(peak.heapUsed) + ' MB, buffers ' + MB(peak.arrayBuffers) + ' MB');
  const pass = ver.ok === true && peak.rss < 512 * 1048576;
  console.log('\n' + (pass ? 'PASS' : 'FAIL') + '  server memory stayed ' + (pass ? 'under' : 'above') + ' 512 MB for a ' + MB_SIZE + ' MB file');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('Test failed:', e); process.exit(2); });
