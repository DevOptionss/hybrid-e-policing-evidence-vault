'use strict';
/**
 * Objective 5 tests: the hash linked chain of custody, checked independently of the chaincode.
 *   node tests/objective5-tests.js | Tee-Object evidence\tests5_output.txt
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obj5-'));
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function api(p, { method = 'GET', acct = 'officerA', headers = {}, body, json } = {}) {
  const h = { 'X-Acct': acct, 'X-Key': KEY, ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body: payload });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, json: type.includes('json') ? await r.json() : null };
}
const save = (acct, buf, name) => api('/api/save', { method: 'POST', acct, body: buf, headers: { 'X-Case': 'T5-' + name, 'X-Name': name, 'X-Mime': 'application/octet-stream', 'Content-Type': 'application/octet-stream' } });
const transfer = (acct, id) => api('/api/transfer', { method: 'POST', acct, headers: { 'X-Id': String(id) } });
const trailOf = (acct, id) => api('/api/custody', { acct, headers: { 'X-Id': String(id) } });

// The verifier, written separately from the server code. Anyone holding an exported trail could run the same steps.
function verify(trail) {
  const problems = [];
  const entries = trail.entries;
  if (!entries.length) return ['no entries'];
  let prev = trail.fileHash;
  entries.forEach((e, i) => {
    if (e.n !== i) problems.push('entry ' + i + ' has the wrong position');
    if (e.prev !== prev) problems.push('entry ' + i + ' does not follow the one before');
    if (e.hash !== sha(JSON.stringify([e.prev, trail.evidenceId, e.from, e.to, e.time, e.txId]))) problems.push('entry ' + i + ' does not match its hash');
    if (i > 0 && e.from !== entries[i - 1].to) problems.push('entry ' + i + ' hands over from someone who did not hold custody');
    prev = e.hash;
  });
  if (prev !== trail.head) problems.push('the last entry does not match the head');
  return problems;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const results = [];
function record(test, scenario, expected, observed, pass) {
  results.push({ test, scenario, expected, pass });
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + observed);
}

(async () => {
  const st = (await api('/api/status')).json;
  if (!st || !st.ready) { console.error('The server is not ready.'); process.exit(2); }
  console.log('Ledger:', st.chain.kind, '\n');
  const data = crypto.randomBytes(50000);

  console.log('TEST C1: a three step chain of custody, checked independently');
  const s = await save('officerA', data, 'custody.bin');
  const id = s.json.evidenceId;
  const t1 = await transfer('officerA', id);
  const t2 = await transfer('officerB', id);
  const tr = (await trailOf('officerA', id)).json;
  const problems = verify(tr);
  const times = tr.entries.map((e) => e.time);
  record('C1', 'Register, hand over twice, verify the trail', 'Three linked entries, valid under independent recomputation',
    'entries ' + tr.count + ', holders ' + tr.entries.map((e) => e.toName).join(' then ') + ', independent check ' + (problems.length ? problems.join('; ') : 'valid') + ', server check ' + tr.independent.valid,
    t1.status === 200 && t2.status === 200 && tr.count === 3 && problems.length === 0 && tr.valid === true && tr.independent.valid === true && times.every((t, i) => i === 0 || t >= times[i - 1]));

  console.log('TEST C2: the trail is tied to the evidence file itself');
  const localHash = sha(data) === tr.fileHash ? true : crypto.createHash('sha256').update(data).digest('hex') === tr.fileHash;
  const other = clone(tr); other.fileHash = crypto.createHash('sha256').update('a different file').digest('hex');
  const pOther = verify(other);
  record('C2', 'Link the chain to the file hash', 'Matches the real file, fails for any other file',
    'real file matches the first link: ' + localHash + ', a different file hash gives ' + pOther.length + ' problem(s)', localHash && pOther.length > 0);

  console.log('TEST C3: forged copies of the trail are detected');
  const forgeries = {
    'a custodian name changed': (t) => { t.entries[1].to = t.entries[2].to; },
    'the middle entry removed': (t) => { t.entries.splice(1, 1); },
    'two entries swapped': (t) => { [t.entries[1], t.entries[2]] = [t.entries[2], t.entries[1]]; },
    'a time edited': (t) => { t.entries[1].time += 1000; },
    'an entry added': (t) => { t.entries.push({ ...t.entries[2], n: 3 }); },
    'the last entry removed': (t) => { t.entries.pop(); },
  };
  const caught = {};
  for (const [label, edit] of Object.entries(forgeries)) { const c = clone(tr); edit(c); caught[label] = verify(c).length > 0; }
  record('C3', 'Forge the trail six ways', 'Every forgery detected', Object.entries(caught).map(([k, v]) => k + ': ' + (v ? 'caught' : 'MISSED')).join(', '), Object.values(caught).every(Boolean));

  console.log('TEST C4: a refused handover leaves no mark on the trail');
  const refused = await transfer('officerB', id);
  const after = (await trailOf('officerA', id)).json;
  record('C4', 'Non custodian tries to take custody', 'Refused and the trail is unchanged',
    'HTTP ' + refused.status + ' (' + (refused.json.error || '') + '), entries still ' + after.count, refused.status === 403 && after.count === 3 && after.head === tr.head);

  console.log('TEST C5: who may read a trail');
  const o = await trailOf('outsider', id), v = await trailOf('verifier', id);
  record('C5', 'Outsider and verifier read the trail', 'Outsider refused, verifier allowed',
    'outsider HTTP ' + o.status + ', verifier HTTP ' + v.status + ' with ' + (v.json && v.json.count) + ' entries', o.status === 403 && /Not authorised/.test(o.json.error) && v.status === 200 && v.json.count === 3);

  console.log('TEST C6: a media manifest has a chain of custody too');
  const file = path.join(tmp, 'clip.bin'); fs.writeFileSync(file, crypto.randomBytes(600000));
  const ing = await api('/api/media/ingest', { method: 'POST', json: { path: file, type: 'cctv', caseId: 'T5-clip', segmentSize: 262144, fileName: 'clip.bin' } });
  await transfer('officerA', ing.json.evidenceId);
  const mt = (await trailOf('officerB', ing.json.evidenceId)).json;
  record('C6', 'Custody of a CCTV record', 'Two linked entries tied to the original file hash',
    'entries ' + mt.count + ', independent check ' + (verify(mt).length ? 'invalid' : 'valid') + ', first link tied to the file hash ' + (mt.entries[0].prev === ing.json.originalHash),
    mt.count === 2 && verify(mt).length === 0 && mt.entries[0].prev === ing.json.originalHash);

  console.log('\nSummary');
  console.log('Test | Scenario | Expected | Result');
  for (const r of results) console.log(r.test + ' | ' + r.scenario + ' | ' + r.expected + ' | ' + (r.pass ? 'PASS' : 'FAIL'));
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (results.length - failed) + ' of ' + results.length + ' tests passed.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test run failed:', e); process.exit(2); });
