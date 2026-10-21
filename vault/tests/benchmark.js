'use strict';
/**
 * Performance measurements through the server's API.
 *   node tests/benchmark.js            (sizes 100 KB, 1 MB, 5 MB, 25 MB, 10 runs each)
 *   node tests/benchmark.js 5          (change the number of runs)
 * Set BENCH_SIZES to limit sizes, for example BENCH_SIZES=100KB,1MB
 * Writes evidence/benchmark.csv with mean, standard deviation, minimum and maximum.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';
const RUNS = Number(process.argv[2]) || 10;
const ALL = { '100KB': 102400, '1MB': 1048576, '5MB': 5242880, '25MB': 26214400 };
const PICK = (process.env.BENCH_SIZES || Object.keys(ALL).join(',')).split(',');   // for example BENCH_SIZES=100KB,1MB
const SIZES = Object.fromEntries(Object.entries(ALL).filter(([k]) => PICK.includes(k)));
const STEPS = ['hash', 'encrypt', 'ipfs_upload', 'ledger_commit'];

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const r1 = (x) => Math.round(x * 10) / 10;

async function post(p, headers, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'X-Acct': 'officerA', 'X-Key': KEY, ...headers }, body });
  const j = await r.json();
  if (!r.ok) throw new Error(p + ': ' + j.error);
  return j;
}

(async () => {
  const rows = [];
  for (const [label, size] of Object.entries(SIZES)) {
    const t = Object.fromEntries([...STEPS, 'register_total', 'verify_total'].map((k) => [k, []]));
    for (let i = 0; i < RUNS; i++) {
      const data = crypto.randomBytes(size);
      const started = performance.now();
      const s = await post('/api/save', { 'X-Case': 'BENCH-' + label + '-' + i, 'X-Name': 'bench.bin', 'X-Mime': 'application/octet-stream', 'Content-Type': 'application/octet-stream' }, data);
      const registerTotal = performance.now() - started;
      s.steps.forEach((v, k) => t[STEPS[k]].push(v));
      t.register_total.push(registerTotal);

      const v0 = performance.now();
      const v = await post('/api/check-vault', { 'X-Id': String(s.evidenceId) });
      t.verify_total.push(performance.now() - v0);
      if (!(v.cidOk && v.hashOk)) throw new Error('Verification failed during the benchmark');
    }
    for (const k of Object.keys(t)) {
      rows.push({ size: label, metric: k, runs: RUNS, mean_ms: r1(mean(t[k])), sd_ms: r1(sd(t[k])), min_ms: r1(Math.min(...t[k])), max_ms: r1(Math.max(...t[k])) });
    }
    console.log(label + '  register ' + r1(mean(t.register_total)) + ' ms (sd ' + r1(sd(t.register_total)) + ')  verify ' + r1(mean(t.verify_total)) + ' ms (sd ' + r1(sd(t.verify_total)) + ')');
  }
  const out = path.join(__dirname, '..', 'evidence');
  fs.mkdirSync(out, { recursive: true });
  const header = Object.keys(rows[0]).join(',');
  fs.writeFileSync(path.join(out, 'benchmark.csv'), [header, ...rows.map((r) => Object.values(r).join(','))].join('\n'));
  console.log('\nsize | metric | mean ms | sd | min | max');
  for (const r of rows) console.log(r.size + ' | ' + r.metric + ' | ' + r.mean_ms + ' | ' + r.sd_ms + ' | ' + r.min_ms + ' | ' + r.max_ms);
  console.log('\nSaved evidence/benchmark.csv');
})().catch((e) => { console.error('Benchmark failed:', e.message); process.exit(1); });
