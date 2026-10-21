'use strict';
/**
 * Objective 4 benchmarks, through the server's API.
 *   node tests\benchmark4.js | Tee-Object evidence\benchmark4_output.txt
 *   node tests\benchmark4.js 5                 (change the number of runs)
 *   $env:BENCH4_SIZES="10,100,500"             (file sizes in MB, default 10 and 100)
 * Reports mean, standard deviation, minimum and maximum, and writes evidence/benchmark4.csv.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';
const RUNS = Number(process.argv[2]) || 10;
const SIZES = (process.env.BENCH4_SIZES || '10,100').split(',').map(Number);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench4-'));
const runsFor = (mb) => (mb <= 10 ? RUNS : mb <= 100 ? Math.min(RUNS, 5) : Math.min(RUNS, 3));

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const r1 = (x) => Math.round(x * 10) / 10;
const rows = [];
function stat(benchmark, size, metric, values, unit) {
  const u = unit === undefined ? ' ms' : unit;
  const row = { benchmark, size, metric, runs: values.length, mean: r1(mean(values)), sd: r1(sd(values)), min: r1(Math.min(...values)), max: r1(Math.max(...values)) };
  rows.push(row);
  console.log('  ' + metric.padEnd(36) + 'mean ' + String(row.mean).padStart(10) + u + '   sd ' + String(row.sd).padStart(8) + '   min ' + String(row.min).padStart(9) + '   max ' + String(row.max).padStart(9));
  return row;
}

async function api(p, { method = 'GET', headers = {}, json } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'X-Acct': 'officerA', 'X-Key': KEY, 'Content-Type': 'application/json', ...headers }, body: json ? JSON.stringify(json) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(p + ': ' + j.error);
  return j;
}
function makeFile(mb, name) {
  const file = path.join(tmp, name); const fd = fs.openSync(file, 'w'); const chunk = crypto.randomBytes(1048576);
  for (let i = 0; i < mb; i++) { crypto.randomFillSync(chunk, 0, 4096); fs.writeSync(fd, chunk); }
  fs.closeSync(fd); return file;
}

(async () => {
  const st = await api('/api/status');
  if (!st.ready) { console.error('The server is not ready.'); process.exit(2); }
  console.log('Ledger: ' + st.chain.kind + ' | cloud tier: ' + (st.tiers.cloud.enabled ? 'on' : 'off') + ' | sizes ' + SIZES.join(', ') + ' MB\n');
  let tierEvidence = null;

  for (const mb of SIZES) {
    const n = runsFor(mb);
    console.log('B1 to B3: ' + mb + ' MB recordings, ' + n + ' runs');
    const file = makeFile(mb, 'bench-' + mb + '.bin');
    const t = { hash: [], encrypt: [], ipfs: [], replicate: [], manifest: [], ledger: [], total: [], verify: [] }; const overhead = [];
    for (let i = 0; i < n; i++) {
      const g = await api('/api/media/ingest', { method: 'POST', json: { path: file, type: 'cctv', caseId: 'B4-' + mb + '-' + i, fileName: 'bench.bin' } });
      for (const k of Object.keys(t)) if (k !== 'verify') t[k].push(g.timings[k]);
      overhead.push(100 * g.manifestBytes / g.fileSize);
      const v = await api('/api/media/verify', { method: 'POST', headers: { 'X-Id': String(g.evidenceId) } });
      if (!v.ok) throw new Error('Verification failed during the benchmark');
      t.verify.push(v.ms);
      if (mb === SIZES[0]) tierEvidence = g.evidenceId;
    }
    for (const k of Object.keys(t)) stat('B1', mb + ' MB', k, t[k]);
    stat('B2', mb + ' MB', 'transactions per item', t.ledger.map(() => 1), '');
    const r3 = (x) => Math.round(x * 1000) / 1000; const o = r3(mean(overhead)); rows.push({ benchmark: 'B3', size: mb + ' MB', metric: 'manifest size as % of file', runs: n, mean: o, sd: r3(sd(overhead)), min: r3(Math.min(...overhead)), max: r3(Math.max(...overhead)) });
    console.log('  manifest size overhead      ' + o + '% of the file (' + Math.ceil(mb * 1048576 / 4194304) + ' segments)');

    // B6: a centralised store, that is a file copy on disk and a hash in a database, with none of the integrity machinery
    const store = [], check = [];
    for (let i = 0; i < n; i++) {
      let s = performance.now(); const dest = path.join(tmp, 'central-' + mb + '-' + i + '.bin'); fs.copyFileSync(file, dest);
      const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.allocUnsafe(4194304); let pos = 0, got;
      while ((got = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) { h.update(buf.subarray(0, got)); pos += got; } fs.closeSync(fd);
      fs.writeFileSync(dest + '.json', JSON.stringify({ hash: h.digest('hex') })); store.push(performance.now() - s);
      s = performance.now(); const h2 = crypto.createHash('sha256'); const fd2 = fs.openSync(dest, 'r'); pos = 0;
      while ((got = fs.readSync(fd2, buf, 0, buf.length, pos)) > 0) { h2.update(buf.subarray(0, got)); pos += got; } fs.closeSync(fd2);
      JSON.parse(fs.readFileSync(dest + '.json')).hash === h2.digest('hex'); check.push(performance.now() - s); fs.unlinkSync(dest); fs.unlinkSync(dest + '.json');
    }
    console.log('B6 centralised baseline, ' + mb + ' MB');
    stat('B6', mb + ' MB', 'baseline store', store); stat('B6', mb + ' MB', 'baseline verify', check);
    fs.unlinkSync(file); console.log('');
  }

  console.log('B2 chaincode query latency (read of one custody trail, 20 calls)');
  const idForQuery = tierEvidence;
  const q = []; for (let i = 0; i < 20; i++) { const s = performance.now(); await api('/api/custody', { headers: { 'X-Id': String(idForQuery) } }); q.push(performance.now() - s); }
  stat('B2', 'n/a', 'query latency', q);

  console.log('\nB4 IoT anchoring: 1000 readings, three batch sizes, 3 runs each');
  for (const size of [100, 500, 1000]) {
    const times = [];
    for (let i = 0; i < 3; i++) { const s = performance.now(); await api('/api/iot/simulate', { method: 'POST', json: { deviceId: 'b4-' + size + '-' + Date.now() + '-' + i, readings: 1000, batchSize: size } }); times.push(performance.now() - s); }
    stat('B4', size + ' per batch', 'time for 1000 readings (' + Math.ceil(1000 / size) + ' tx)', times);
  }
  const single = [];
  for (let i = 0; i < 2; i++) { const s = performance.now(); await api('/api/iot/simulate', { method: 'POST', json: { deviceId: 'b4-one-' + Date.now() + '-' + i, readings: 20, batchSize: 1 } }); single.push((performance.now() - s) / 20); }
  const perTx = stat('B4', 'one reading each', 'time per reading (1 tx)', single);
  console.log('  one transaction per reading would take about ' + r1(perTx.mean * 1000 / 1000) + ' s per 1000 readings (extrapolated from the measurement above)');
  rows.push({ benchmark: 'B4', size: 'one reading each', metric: 'extrapolated ms for 1000 readings', runs: 2, mean: r1(perTx.mean * 1000), sd: 0, min: 0, max: 0 });

  if (st.tiers.cloud.enabled && tierEvidence) {
    console.log('\nB7 storage tiers: verification of a ' + SIZES[0] + ' MB recording, 5 runs each');
    const both = [], cloudOnly = [];
    for (let i = 0; i < 5; i++) { both.push((await api('/api/media/verify', { method: 'POST', headers: { 'X-Id': String(tierEvidence) } })).ms); }
    await fetch(BASE + '/api/tiers/outage?on=1', { method: 'POST' });
    for (let i = 0; i < 5; i++) { cloudOnly.push((await api('/api/media/verify', { method: 'POST', headers: { 'X-Id': String(tierEvidence) } })).ms); }
    await fetch(BASE + '/api/tiers/outage?on=0', { method: 'POST' });
    stat('B7', SIZES[0] + ' MB', 'verify, on premise node', both); stat('B7', SIZES[0] + ' MB', 'verify, cloud node only', cloudOnly);
    console.log('  replication to the cloud node is the "replicate" figure in B1');
  }

  fs.mkdirSync(path.join(__dirname, '..', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'benchmark4.csv'), ['benchmark,size,metric,runs,mean,sd,min,max', ...rows.map((r) => [r.benchmark, r.size, r.metric, r.runs, r.mean, r.sd, r.min, r.max].join(','))].join('\n'));
  console.log('\nSaved evidence/benchmark4.csv');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('Benchmark failed:', e.message); process.exit(1); });
