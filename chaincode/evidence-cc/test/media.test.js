'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const EvidenceContract = require('../lib/evidence');
const MediaContract = require('../lib/media');
const { newWorld, ctxFor } = require('./helpers');

const ADMIN = 'x509::CN=Admin,O=Org1', INV = 'x509::CN=User1,O=Org1', VER = 'x509::CN=Admin,O=Org2', OUT = 'x509::CN=User1,O=Org2';
const HASH = 'a'.repeat(64), ROOT = 'b'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const as = (w, id) => ctxFor(w, id, id === VER || id === OUT ? 'Org2MSP' : 'Org1MSP');

async function ready() {
  const ev = new EvidenceContract();
  const md = new MediaContract();
  const w = newWorld();
  await ev.InitLedger(as(w, ADMIN));
  await ev.AddInvestigator(as(w, ADMIN), INV);
  await ev.AddVerifier(as(w, ADMIN), VER);
  return { ev, md, w };
}

// Independent recomputation of the custody chain, as an outside verifier would do it.
function verifyTrail(trail) {
  let prev = trail.fileHash;
  for (const e of trail.entries) {
    const expected = sha(JSON.stringify([e.prev, trail.evidenceId, e.from, e.to, e.time, e.txId]));
    if (e.prev !== prev || e.hash !== expected) return false;
    prev = e.hash;
  }
  return trail.entries.length > 0 && prev === trail.head;
}

test('registration starts a custody chain tied to the file hash', async () => {
  const { ev, w } = await ready();
  await ev.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  const trail = JSON.parse(await ev.GetCustodyTrail(as(w, VER), '1'));
  assert.strictEqual(trail.count, 1);
  assert.strictEqual(trail.entries[0].prev, HASH);
  assert.strictEqual(trail.valid, true);
  assert.ok(verifyTrail(trail));
});

test('each handover adds a linked entry that an outside verifier can recompute', async () => {
  const { ev, w } = await ready();
  await ev.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await ev.TransferCustody(as(w, INV), '1', ADMIN);
  await ev.TransferCustody(as(w, ADMIN), '1', INV);
  const trail = JSON.parse(await ev.GetCustodyTrail(as(w, INV), '1'));
  assert.strictEqual(trail.count, 3);
  assert.deepStrictEqual(trail.entries.map((e) => e.to), [INV, ADMIN, INV]);
  assert.strictEqual(trail.valid, true);
  assert.ok(verifyTrail(trail));
});

test('editing or removing a custody entry is detected', async () => {
  const { ev, w } = await ready();
  await ev.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await ev.TransferCustody(as(w, INV), '1', ADMIN);
  const key = 'CUST~00000001~000001';
  const original = w.state.get(key);
  const forged = JSON.parse(original.toString()); forged.to = OUT;
  w.state.set(key, Buffer.from(JSON.stringify(forged)));
  assert.strictEqual(JSON.parse(await ev.GetCustodyTrail(as(w, INV), '1')).valid, false);
  w.state.set(key, original);
  assert.strictEqual(JSON.parse(await ev.GetCustodyTrail(as(w, INV), '1')).valid, true);
  w.state.delete(key);
  assert.strictEqual(JSON.parse(await ev.GetCustodyTrail(as(w, INV), '1')).valid, false);
});

test('the custody trail is readable by roles only', async () => {
  const { ev, w } = await ready();
  await ev.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await assert.rejects(() => ev.GetCustodyTrail(as(w, OUT), '1'), /Not authorised/);
});

test('events carry a timestamp', async () => {
  const { ev, w } = await ready();
  await ev.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await ev.TransferCustody(as(w, INV), '1', ADMIN);
  for (const e of w.events) assert.ok(e.payload.time > 1700000000000, e.name + ' has no time');
});

test('a manifest is registered as evidence with media details', async () => {
  const { ev, md, w } = await ready();
  const r = JSON.parse(await md.RegisterManifest(as(w, INV), 'CAS-2', 'cctv', 'QmManifest', ROOT, HASH, '25', '1700000000000', '1700000250000'));
  assert.strictEqual(r.evidenceId, 1);
  const m = JSON.parse(await md.GetManifest(as(w, VER), '1'));
  assert.strictEqual(m.media.merkleRoot, ROOT);
  assert.strictEqual(m.media.segmentCount, 25);
  assert.strictEqual(m.evidence.cid, 'QmManifest');
  await ev.TransferCustody(as(w, INV), '1', ADMIN);
  assert.strictEqual(JSON.parse(await ev.GetCustodyTrail(as(w, ADMIN), '1')).valid, true);
  assert.ok(w.events.some((e) => e.name === 'ManifestRegistered' && e.payload.evidenceType === 'cctv'));
});

test('manifest registration checks roles and inputs', async () => {
  const { md, w } = await ready();
  const args = ['CAS-2', 'cctv', 'QmM', ROOT, HASH, '25', '10', '20'];
  await assert.rejects(() => md.RegisterManifest(as(w, OUT), ...args), /Not authorised/);
  await assert.rejects(() => md.RegisterManifest(as(w, VER), ...args), /Not authorised/);
  await assert.rejects(() => md.RegisterManifest(as(w, INV), 'CAS-2', 'audio', 'QmM', ROOT, HASH, '25', '10', '20'), /evidence type/);
  await assert.rejects(() => md.RegisterManifest(as(w, INV), 'CAS-2', 'cctv', 'QmM', 'xyz', HASH, '25', '10', '20'), /Merkle root/);
  await assert.rejects(() => md.RegisterManifest(as(w, INV), 'CAS-2', 'cctv', 'QmM', ROOT, HASH, '0', '10', '20'), /segment count/);
  await assert.rejects(() => md.RegisterManifest(as(w, INV), 'CAS-2', 'cctv', 'QmM', ROOT, HASH, '25', '30', '20'), /capture end/);
});

test('GetManifest refuses a record that is not a manifest', async () => {
  const { ev, md, w } = await ready();
  await ev.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await assert.rejects(() => md.GetManifest(as(w, INV), '1'), /Not a manifest record/);
});

test('only the administrator registers a device, once', async () => {
  const { md, w } = await ready();
  await assert.rejects(() => md.RegisterDevice(as(w, INV), 'cam-1', INV), /Not authorised/);
  await assert.rejects(() => md.RegisterDevice(as(w, ADMIN), 'bad id!', INV), /device ID/);
  await md.RegisterDevice(as(w, ADMIN), 'cam-1', INV);
  await assert.rejects(() => md.RegisterDevice(as(w, ADMIN), 'cam-1', INV), /already registered/);
});

test('batches must arrive in order from the bound gateway', async () => {
  const { md, w } = await ready();
  await md.RegisterDevice(as(w, ADMIN), 'cam-1', INV);
  const a = JSON.parse(await md.AnchorBatch(as(w, INV), 'cam-1', '1', ROOT, '500', 'QmB1'));
  const b = JSON.parse(await md.AnchorBatch(as(w, INV), 'cam-1', '2', 'c'.repeat(64), '480', 'QmB2'));
  assert.strictEqual(a.batchIndex, 1);
  assert.strictEqual(b.batchIndex, 2);
  await assert.rejects(() => md.AnchorBatch(as(w, INV), 'cam-1', '2', ROOT, '10', 'QmB2'), /already anchored/);
  await assert.rejects(() => md.AnchorBatch(as(w, INV), 'cam-1', '5', ROOT, '10', 'QmB5'), /out of sequence, expected 3/);
  await assert.rejects(() => md.AnchorBatch(as(w, OUT), 'cam-1', '3', ROOT, '10', 'QmB3'), /Not authorised/);
  await assert.rejects(() => md.AnchorBatch(as(w, VER), 'cam-1', '3', ROOT, '10', 'QmB3'), /Not authorised/);
  await assert.rejects(() => md.AnchorBatch(as(w, INV), 'nope', '1', ROOT, '10', 'QmB'), /No such device/);
});

test('the batch chain can be recomputed from outside', async () => {
  const { md, w } = await ready();
  await md.RegisterDevice(as(w, ADMIN), 'cam-1', INV);
  await md.AnchorBatch(as(w, INV), 'cam-1', '1', ROOT, '500', 'QmB1');
  await md.AnchorBatch(as(w, INV), 'cam-1', '2', 'c'.repeat(64), '480', 'QmB2');
  const chain = JSON.parse(await md.GetBatchChain(as(w, VER), 'cam-1'));
  assert.strictEqual(chain.length, 2);
  let prev = '0'.repeat(64);
  for (const b of chain) {
    assert.strictEqual(b.prevHash, prev);
    assert.strictEqual(b.batchHash, sha(JSON.stringify([prev, b.merkleRoot, b.batchIndex, 'cam-1'])));
    prev = b.batchHash;
  }
  const head = JSON.parse(await md.LastBatch(as(w, OUT), 'cam-1'));
  assert.deepStrictEqual(head, { count: 2, lastHash: prev });
  assert.strictEqual(JSON.parse(await md.GetBatch(as(w, INV), 'cam-1', '1')).cid, 'QmB1');
  await assert.rejects(() => md.GetBatchChain(as(w, OUT), 'cam-1'), /Not authorised/);
});

test('the media contract methods are the public interface', () => {
  const names = Object.getOwnPropertyNames(MediaContract.prototype).filter((n) => n !== 'constructor');
  for (const n of ['RegisterDevice', 'RegisterManifest', 'GetManifest', 'AnchorBatch', 'GetBatch', 'LastBatch', 'GetBatchChain']) assert.ok(names.includes(n), n);
});
