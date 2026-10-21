'use strict';
/**
 * Objective 3 tests, run through the server's API (works against Fabric or the --demo ledger).
 *   node tests/objective3-tests.js
 * Save the output with:  node tests\objective3-tests.js | Tee-Object evidence\tests_output.txt
 */
const crypto = require('crypto');

const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = '0.3141592653589793';

async function call(path, { method = 'GET', acct = 'officerA', body, headers = {} } = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'X-Acct': acct, 'X-Key': KEY, ...headers }, body });
  const type = r.headers.get('content-type') || '';
  if (type.includes('application/json')) return { status: r.status, json: await r.json() };
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
const save = (acct, buf, caseId, name) => call('/api/save', {
  method: 'POST', acct, body: buf,
  headers: { 'X-Case': encodeURIComponent(caseId), 'X-Name': encodeURIComponent(name), 'X-Mime': 'application/octet-stream', 'Content-Type': 'application/octet-stream' },
});
const checkVault = (acct, id) => call('/api/check-vault', { method: 'POST', acct, headers: { 'X-Id': String(id) } });
const checkFile = (acct, id, buf) => call('/api/check-file', { method: 'POST', acct, body: buf, headers: { 'X-Id': String(id), 'Content-Type': 'application/octet-stream' } });
const attack = (kind, id) => call('/api/attack?kind=' + kind, { method: 'POST', headers: { 'X-Id': String(id) } });
const transfer = (acct, id) => call('/api/transfer', { method: 'POST', acct, headers: { 'X-Id': String(id) } });

const results = [];
function record(test, scenario, expected, observed, pass) {
  results.push({ test, scenario, expected, observed, pass });
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + observed);
}

(async () => {
  const status = await call('/api/status');
  if (!status.json || !status.json.ready) { console.error('The server is not ready. Check IPFS and the ledger, then try again.'); process.exit(2); }
  console.log('Ledger:', status.json.chain.kind, '| IPFS', status.json.ipfs.version, '\n');

  const original = crypto.randomBytes(102400);
  const tampered = Buffer.from(original); tampered[100] ^= 1;

  console.log('TEST 1: genuine evidence is saved and verifies');
  const s1 = await save('officerA', original, 'CAS-T-001', 'sample_evidence.bin');
  const id1 = s1.json.evidenceId;
  const v1 = await checkVault('officerA', id1);
  record(1, 'Register and verify genuine evidence', 'Verification passes', 'Evidence ' + id1 + ' verified: ' + (v1.json.cidOk && v1.json.hashOk), v1.json.cidOk && v1.json.hashOk);

  console.log('TEST 2: an altered file (one bit flipped) is compared with the ledger hash');
  const okFile = await checkFile('officerA', id1, original);
  const badFile = await checkFile('officerA', id1, tampered);
  record(2, 'Compare an altered file with the ledger hash', 'Original matches, altered does not',
    'Original matches: ' + okFile.json.hashOk + ', altered matches: ' + badFile.json.hashOk, okFile.json.hashOk === true && badFile.json.hashOk === false);

  console.log('TEST 3: the altered content receives a different content ID');
  const a3 = await attack('altered_copy', id1);
  const d3 = a3.json.data;
  record(3, 'Add the altered copy to IPFS', 'A different content ID, original untouched',
    'Registered ' + d3.registeredCid + ' against altered ' + d3.alteredCid + ', original intact: ' + d3.originalIntact,
    d3.registeredCid !== d3.alteredCid && d3.originalIntact === true);

  console.log('TEST 4: a record is made to point at the altered copy');
  const a4 = await attack('swap_copy', id1);
  const v4 = await checkVault('officerA', a4.json.select);
  record(4, 'Swap the stored copy behind a record', 'Verification fails',
    'Evidence ' + a4.json.select + ' verification result: ' + (v4.json.hashOk && v4.json.cidOk), v4.json.hashOk === false);

  console.log('TEST 5: an unauthorised identity tries to register evidence');
  const s5 = await save('outsider', original, 'CAS-X', 'x.bin');
  record(5, 'Unauthorised identity registers evidence', 'Refused by the chaincode',
    'HTTP ' + s5.status + ': ' + (s5.json && s5.json.error), s5.status === 403 && /Not authorised/.test(s5.json.error));

  console.log('TEST 6: a verifier can read and check but cannot register');
  const s6 = await save('verifier', original, 'CAS-V', 'v.bin');
  const v6 = await checkVault('verifier', id1);
  record(6, 'Read only verifier', 'Save refused, check allowed',
    'Save: HTTP ' + s6.status + ', check intact: ' + (v6.json.cidOk && v6.json.hashOk), s6.status === 403 && v6.json.cidOk && v6.json.hashOk);

  console.log('TEST 7: custody can only be handed over by the current custodian');
  const t7a = await transfer('officerB', id1);
  const t7b = await transfer('officerA', id1);
  const t7c = await transfer('officerA', id1);
  record(7, 'Custody rules', 'Non custodian refused, custodian accepted, former custodian then refused',
    'B: ' + t7a.status + ', A: ' + t7b.status + ', A again: ' + t7c.status + ' (' + (t7c.json.error || '') + ')',
    t7a.status === 403 && /Not custodian/.test(t7a.json.error) && t7b.status === 200 && t7c.status === 403);

  console.log('\nSummary');
  console.log('Test | Scenario | Expected | Result');
  for (const r of results) console.log(r.test + ' | ' + r.scenario + ' | ' + r.expected + ' | ' + (r.pass ? 'PASS' : 'FAIL'));
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + (results.length - failed) + ' of ' + results.length + ' tests passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test run failed:', e); process.exit(2); });
