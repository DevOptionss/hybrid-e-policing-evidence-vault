'use strict';
/**
 * Tamper detection trial (Objective 4 test 15 and the proposal's "tamper detection accuracy").
 * Random single bit changes and untouched copies are checked against the ledger.
 *   $env:TRIALS=100; node tests\detection-trial.js | Tee-Object evidence\detection_trial.txt
 * Needs FFmpeg for the footage, or falls back to random bytes.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';
const TRIALS = Number(process.env.TRIALS) || 100;
const SEG = 262144;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));

async function api(p, { method = 'GET', headers = {}, body, json } = {}) {
  const h = { 'X-Acct': 'officerA', 'X-Key': KEY, ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  return { status: r.status, json: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null, text: async () => r.text() };
}
function wilson(k, n, z = 1.96) {                     // 95% Wilson interval for a proportion
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
const pc = (x) => (100 * x).toFixed(1) + '%';
const ci = (k, n) => { const [a, b] = wilson(k, n); return pc(k / n) + ' (95% interval ' + pc(a) + ' to ' + pc(b) + ')'; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

async function runKind(label, original, check, mutate) {
  let detected = 0, located = 0, falsePositives = 0; const times = [];
  for (let i = 0; i < TRIALS; i++) {
    const m = mutate(original);
    let t = performance.now(); const bad = await check(m.data); times.push(performance.now() - t);
    if (!bad.ok) detected++;
    if (m.expect(bad)) located++;
    t = performance.now(); const good = await check(original); times.push(performance.now() - t);
    if (!good.ok) falsePositives++;
  }
  console.log(label.padEnd(22) + ' detection ' + ci(detected, TRIALS) + ' | located correctly ' + ci(located, TRIALS) + ' | false alarms ' + ci(falsePositives, TRIALS) + ' | ' + Math.round(mean(times)) + ' ms per check');
  return { label, trials: TRIALS, detected, located, falsePositives };
}

(async () => {
  const st = (await api('/api/status')).json;
  if (!st || !st.ready) { console.error('The server is not ready.'); process.exit(2); }
  console.log('Ledger:', st.chain.kind, '| trials per kind:', TRIALS, '(each trial is one changed copy and one untouched copy)\n');

  const video = path.join(tmp, 'cctv.mp4');
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=640x360:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '800k', video]);
  if (ff.status !== 0) fs.writeFileSync(video, crypto.randomBytes(1500000));
  const footage = fs.readFileSync(video);
  const photo = crypto.randomBytes(300 * 1024); const photoFile = path.join(tmp, 'photo.jpg'); fs.writeFileSync(photoFile, photo);

  const i1 = await api('/api/media/ingest', { method: 'POST', json: { path: video, type: 'cctv', caseId: 'TRIAL-cctv', segmentSize: SEG, fileName: 'cctv.mp4' } });
  const i2 = await api('/api/media/ingest', { method: 'POST', json: { path: photoFile, type: 'multimedia', caseId: 'TRIAL-photo', segmentSize: SEG, fileName: 'photo.jpg' } });
  const dev = 'trial-' + Date.now();
  await api('/api/iot/simulate', { method: 'POST', json: { deviceId: dev, readings: 500, batchSize: 500 } });
  const exported = await (await fetch(BASE + '/api/iot/export?device=' + dev + '&batch=1', { headers: { 'X-Acct': 'officerA', 'X-Key': KEY } })).text();

  const checkFile = (id) => async (buf) => { const r = (await api('/api/media/check-file', { method: 'POST', headers: { 'X-Id': String(id), 'Content-Type': 'application/octet-stream' }, body: buf })).json; return r; };
  const checkBatch = async (text) => { const r = (await api('/api/iot/check-batch', { method: 'POST', headers: { 'X-Device': dev, 'X-Batch': '1' }, body: text })).json; return r; };
  const flipBit = (buf, seg) => {
    const data = Buffer.from(buf); const off = crypto.randomInt(0, data.length); data[off] ^= 1 << crypto.randomInt(0, 8);
    return { data, expect: (r) => r.diff && r.diff.changed && r.diff.changed.length === 1 && r.diff.changed[0] === Math.floor(off / seg) };
  };

  const rows = [];
  rows.push(await runKind('CCTV footage', footage, checkFile(i1.json.evidenceId), (b) => flipBit(b, SEG)));
  rows.push(await runKind('Photograph', photo, checkFile(i2.json.evidenceId), (b) => flipBit(b, SEG)));
  rows.push(await runKind('IoT sensor batch', exported, checkBatch, (text) => {
    const o = JSON.parse(text); const idx = crypto.randomInt(0, o.readings.length); o.readings[idx].value = Math.round((o.readings[idx].value + 0.01) * 100) / 100;
    return { data: JSON.stringify(o), expect: (r) => r.changedReadings && r.changedReadings.length === 1 && r.changedReadings[0] === idx };
  }));

  const total = rows.reduce((s, r) => s + r.trials, 0), det = rows.reduce((s, r) => s + r.detected, 0), fp = rows.reduce((s, r) => s + r.falsePositives, 0);
  console.log('\nAll kinds together: detection ' + ci(det, total) + ', false alarms ' + ci(fp, total));
  fs.mkdirSync(path.join(__dirname, '..', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'detection_trial.json'), JSON.stringify({ trials: TRIALS, rows }, null, 2));
  console.log('Saved evidence/detection_trial.json');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(det === total && fp === 0 ? 0 : 1);
})().catch((e) => { console.error('Trial failed:', e); process.exit(2); });
