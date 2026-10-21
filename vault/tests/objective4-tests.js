'use strict';
/**
 * Objective 4 tests (multimedia, CCTV and IoT evidence), run through the server's API.
 *   node tests/objective4-tests.js
 * Needs FFmpeg to create test footage. Optional settings:
 *   LARGE_MB=500        size of the large file test T13 (default 100)
 *   CLOUD_IPFS_API set on the server enables test T14 (cloud failover)
 * Save the output with:  node tests\objective4-tests.js | Tee-Object evidence\tests4_output.txt
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';
const SEG = 262144;                                   // 256 KiB segments keep the test files small
const LARGE_MB = Number(process.env.LARGE_MB) || 100;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obj4-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function api(p, { method = 'GET', acct = 'officerA', headers = {}, body, json } = {}) {
  const h = { 'X-Acct': acct, 'X-Key': KEY, ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, json: type.includes('json') ? await r.json() : null };
}
const ingest = (acct, file, type, name, extra) => api('/api/media/ingest', { method: 'POST', acct, json: { path: file, type, caseId: 'T4-' + name, segmentSize: SEG, fileName: name, ...(extra || {}) } });
const verify = (acct, id) => api('/api/media/verify', { method: 'POST', acct, headers: { 'X-Id': String(id) } });
const checkBuffer = (id, buf) => api('/api/media/check-file', { method: 'POST', headers: { 'X-Id': String(id), 'Content-Type': 'application/octet-stream' }, body: buf });
const sameSet = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

const results = [];
function record(test, scenario, expected, observed, pass) {
  results.push({ test, scenario, expected, pass });
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + observed);
}

function makeFootage() {
  const video = path.join(tmp, 'cctv.mp4'), audio = path.join(tmp, 'recording.wav'), photo = path.join(tmp, 'photo.jpg');
  const v = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '800k', '-c:a', 'aac', '-shortest', video]);
  if (v.status !== 0) throw new Error('FFmpeg could not create test footage. Install it with: winget install Gyan.FFmpeg');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', audio]);
  fs.writeFileSync(photo, crypto.randomBytes(300 * 1024));
  return { video, audio, photo };
}

(async () => {
  const st = (await api('/api/status')).json;
  if (!st || !st.ready) { console.error('The server is not ready. Check IPFS and the ledger, then try again.'); process.exit(2); }
  console.log('Ledger:', st.chain.kind, '| IPFS', st.ipfs.version, '| cloud tier:', st.tiers.cloud.enabled ? 'on' : 'off', '\n');
  const files = makeFootage();
  const footage = fs.readFileSync(files.video), audioBuf = fs.readFileSync(files.audio), photoBuf = fs.readFileSync(files.photo);
  const n = Math.ceil(footage.length / SEG);
  console.log('Test footage: ' + footage.length + ' bytes in ' + n + ' segments of ' + SEG + ' bytes\n');

  console.log('TEST 1: genuine footage, audio and photograph are ingested and verified');
  const i1 = await ingest('officerA', files.video, 'cctv', 'cctv.mp4');
  const i2 = await ingest('officerA', files.audio, 'multimedia', 'recording.wav');
  const i3 = await ingest('officerA', files.photo, 'multimedia', 'photo.jpg');
  const v1 = [await verify('officerA', i1.json.evidenceId), await verify('officerA', i2.json.evidenceId), await verify('officerA', i3.json.evidenceId)];
  const hashesOk = i1.json.originalHash === sha(footage) && i2.json.originalHash === sha(audioBuf) && i3.json.originalHash === sha(photoBuf);
  const allOk = v1.every((v) => v.json.ok && v.json.wholeFile.ok);
  record(1, 'Ingest and verify footage, audio and photograph', 'All pass and file hashes match the originals',
    'CCTV ' + i1.json.segmentCount + ' segments (time index ' + i1.json.timeIndex + '), audio ' + i2.json.segmentCount + ', photo ' + i3.json.segmentCount + ', all verified: ' + allOk + ', hashes match originals: ' + hashesOk, allOk && hashesOk);
  const id = i1.json.evidenceId;

  const tamper = async (label, buf) => (await checkBuffer(id, buf)).json;
  const win = (r) => (r.located && r.located[0] ? 'segment ' + r.located[0].i + ' window ' + new Date(r.located[0].t0).toISOString().slice(11, 19) + ' to ' + new Date(r.located[0].t1).toISOString().slice(11, 19) : 'none');

  console.log('TEST 2: one bit flipped inside one segment of the footage');
  const f2 = Buffer.from(footage); f2[4 * SEG + 100] ^= 1;
  const r2 = await tamper('flip', f2);
  record(2, 'Flip one bit in one segment', 'Fails and names the segment and its time window',
    'kind ' + r2.diff.kind + ', changed ' + JSON.stringify(r2.diff.changed) + ', ' + win(r2), r2.diff.kind === 'altered' && sameSet(r2.diff.changed, [4]) && !r2.ok && r2.located[0].t1 >= r2.located[0].t0);

  console.log('TEST 3: one segment removed from the footage');
  const f3 = Buffer.concat([footage.subarray(0, 3 * SEG), footage.subarray(4 * SEG)]);
  const r3 = await tamper('delete', f3);
  record(3, 'Remove one segment', 'The missing segment is reported',
    'kind ' + r3.diff.kind + ' at ' + r3.diff.at + ', missing ' + JSON.stringify(r3.diff.missing), r3.diff.kind === 'deleted' && r3.diff.at === 3 && !r3.ok);

  console.log('TEST 4: two segments swapped');
  const blocks = (b) => Array.from({ length: Math.ceil(b.length / SEG) }, (_, i) => b.subarray(i * SEG, (i + 1) * SEG));
  const bl = blocks(footage); const t = bl[2]; bl[2] = bl[5]; bl[5] = t;
  const r4 = await tamper('swap', Buffer.concat(bl));
  record(4, 'Swap two segments', 'The reordering is reported', 'kind ' + r4.diff.kind + ', changed ' + JSON.stringify(r4.diff.changed), r4.diff.kind === 'reordered' && sameSet(r4.diff.changed, [2, 5]) && !r4.ok);

  console.log('TEST 5: the end of the recording cut off');
  const r5 = await tamper('truncate', footage.subarray(0, (n - 2) * SEG));
  record(5, 'Cut the last segments', 'Truncation is reported', 'kind ' + r5.diff.kind + ', missing ' + JSON.stringify(r5.diff.missing), r5.diff.kind === 'truncated' && sameSet(r5.diff.missing, [n - 2, n - 1]) && !r5.ok);

  console.log('TEST 6: a segment from another recording inserted in place of segment 1');
  const bl6 = blocks(footage); bl6[1] = audioBuf.subarray(SEG, 2 * SEG);
  const r6 = await tamper('foreign', Buffer.concat(bl6));
  record(6, 'Foreign segment', 'The substituted segment is reported', 'kind ' + r6.diff.kind + ', changed ' + JSON.stringify(r6.diff.changed), r6.diff.kind === 'altered' && sameSet(r6.diff.changed, [1]) && !r6.ok);

  console.log('TEST 7: a segment hash edited inside the manifest');
  const a7 = await api('/api/media/attack?kind=manifest_edit', { method: 'POST', headers: { 'X-Id': String(id) } });
  const v7 = await verify('officerA', a7.json.select);
  record(7, 'Edit the manifest', 'The rebuilt Merkle root differs from the anchored root', 'evidence ' + a7.json.select + ': root ok ' + v7.json.root.ok + ', verified ' + v7.json.ok, v7.json.ok === false && v7.json.root.ok === false);

  console.log('TEST 8: one bit flipped in a photograph');
  const f8 = Buffer.from(photoBuf); f8[100] ^= 1;
  const r8 = (await checkBuffer(i3.json.evidenceId, f8)).json;
  const r8ok = (await checkBuffer(i3.json.evidenceId, photoBuf)).json;
  record(8, 'Flip one bit in a photograph', 'Hash mismatch against the ledger', 'altered file matches: ' + r8.hashMatch + ', original matches: ' + r8ok.hashMatch, r8.hashMatch === false && r8ok.hashMatch === true);

  console.log('TEST 9: one sensor reading edited inside a batch');
  const dev = 'dev-' + Date.now();
  const sim = await api('/api/iot/simulate', { method: 'POST', json: { deviceId: dev, readings: 1200, batchSize: 500 } });
  const vd = await api('/api/iot/verify', { method: 'POST', json: { deviceId: dev } });
  const exp = await fetch(BASE + '/api/iot/export?device=' + dev + '&batch=2', { headers: { 'X-Acct': 'officerA', 'X-Key': KEY } });
  const original = await exp.text();
  const edited = JSON.parse(original); edited.readings[17].value += 1;
  const cb = (text) => api('/api/iot/check-batch', { method: 'POST', headers: { 'X-Device': dev, 'X-Batch': '2' }, body: text });
  const bad = (await cb(JSON.stringify(edited))).json, good = (await cb(original)).json;
  record(9, 'Edit one sensor reading', 'The batch root no longer matches and the reading is named',
    sim.json.batches.length + ' batches anchored, device verified ' + vd.json.ok + ', edited batch changed readings ' + JSON.stringify(bad.changedReadings) + ', untouched batch matches ' + good.ok,
    sim.json.batches.length === 3 && vd.json.ok === true && sameSet(bad.changedReadings, [17]) && bad.rootMatch === false && good.ok === true);

  console.log('TEST 10 and 11: a gap in the batch index and a replayed batch');
  const raw = (index) => api('/api/iot/raw-anchor', { method: 'POST', json: { deviceId: dev, index, root: 'c'.repeat(64), count: 10, cid: 'QmRaw' } });
  const gap = await raw(9), replay = await raw(1);
  record(10, 'Gap in the batch index', 'Refused by the chaincode', 'HTTP ' + gap.status + ': ' + gap.json.error, gap.status === 403 && /out of sequence/.test(gap.json.error));
  record(11, 'Replay of an old batch', 'Refused by the chaincode', 'HTTP ' + replay.status + ': ' + replay.json.error, replay.status === 403 && /already anchored/.test(replay.json.error));

  console.log('TEST 12: roles on the media functions');
  const o = await ingest('outsider', files.photo, 'multimedia', 'x.jpg');
  const vr = await ingest('verifier', files.photo, 'multimedia', 'x.jpg');
  const vv = await verify('verifier', id);
  const oa = await api('/api/iot/raw-anchor', { method: 'POST', json: { acct: 'outsider', deviceId: dev, index: 4, root: 'd'.repeat(64), count: 10, cid: 'QmRaw' } });
  record(12, 'Outsider and verifier', 'Writes refused, verification allowed',
    'outsider ingest ' + o.status + ', verifier ingest ' + vr.status + ', verifier verify ok ' + vv.json.ok + ', outsider anchor ' + oa.status,
    o.status === 403 && /Not authorised/.test(o.json.error) && vr.status === 403 && vv.json.ok === true && oa.status === 403);

  console.log('TEST 13: a large file is ingested and verified without loading it into memory (' + LARGE_MB + ' MB)');
  const big = path.join(tmp, 'large.bin');
  const fd = fs.openSync(big, 'w'); const chunk = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < LARGE_MB; i++) { crypto.randomFillSync(chunk, 0, 4096); fs.writeSync(fd, chunk); }
  fs.closeSync(fd);
  const base = (await api('/api/status')).json.rss; let peak = base; let polling = true;
  const MB = (x) => Math.round(x / 1048576);
  const poll = (async () => { while (polling) { const s = (await api('/api/status')).json; if (s && s.rss > peak) peak = s.rss; await new Promise((r) => setTimeout(r, 400)); } })();
  const big1 = await api('/api/media/ingest', { method: 'POST', json: { path: big, type: 'cctv', caseId: 'T4-large', fileName: 'large.bin' } });
  const bigV = await verify('officerA', big1.json.evidenceId);
  polling = false; await poll;
  record(13, 'Large file without loading it into memory', 'Completes, with server memory staying under 512 MB',
    LARGE_MB + ' MB in ' + big1.json.segmentCount + ' segments, ingest ' + Math.round(big1.json.timings.total / 1000) + ' s, verify ' + Math.round(bigV.json.ms / 1000) + ' s, verified ' + bigV.json.ok + ', server memory ' + MB(base) + ' MB before and ' + MB(peak) + ' MB at the peak',
    big1.status === 200 && bigV.json.ok === true && peak < 512 * 1048576);

  console.log('TEST 14: retrieval and verification from the cloud node while the on premise node is unavailable');
  if (!st.tiers.cloud.enabled) {
    console.log('  SKIP  the server was started without CLOUD_IPFS_API');
  } else {
    await api('/api/tiers/outage?on=1', { method: 'POST' });
    const v14 = await verify('officerA', id);
    await api('/api/tiers/outage?on=0', { method: 'POST' });
    record(14, 'Cloud failover', 'Verification succeeds using the cloud node only',
      'verified ' + v14.json.ok + ', segments read from premise ' + v14.json.tiers.premise + ' and from cloud ' + v14.json.tiers.cloud, v14.json.ok === true && v14.json.tiers.premise === 0 && v14.json.tiers.cloud > 0);
  }

  console.log('\nSummary');
  console.log('Test | Scenario | Expected | Result');
  for (const r of results) console.log(r.test + ' | ' + r.scenario + ' | ' + r.expected + ' | ' + (r.pass ? 'PASS' : 'FAIL'));
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (results.length - failed) + ' of ' + results.length + ' tests passed. (Test 15, the detection rate trial, and test 16, the Objective 3 regression, run separately.)');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test run failed:', e); process.exit(2); });
