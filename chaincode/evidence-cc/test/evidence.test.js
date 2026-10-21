'use strict';

const test = require('node:test');
const assert = require('node:assert');
const EvidenceContract = require('../lib/evidence');

// A small in memory stand in for the Fabric ledger, so the chaincode logic can be tested
// without starting a network.
function newWorld() {
  return { state: new Map(), history: new Map(), events: [], tx: 0 };
}

function ctxFor(world, id, msp) {
  const stub = {
    getState: async (k) => (world.state.has(k) ? Buffer.from(world.state.get(k)) : Buffer.alloc(0)),
    putState: async (k, v) => {
      world.state.set(k, Buffer.from(v));
      if (!world.history.has(k)) world.history.set(k, []);
      world.history.get(k).push({ txId: 'tx' + world.tx, timestamp: { seconds: { low: 1700000000 + world.tx, high: 0 }, nanos: 0 }, isDelete: false, value: Buffer.from(v) });
    },
    getStateByRange: async (a, b) => {
      const keys = [...world.state.keys()].filter((k) => k >= a && k < b).sort();
      let i = 0;
      return {
        next: async () => (i < keys.length ? { value: { value: world.state.get(keys[i++]) }, done: false } : { value: undefined, done: true }),
        close: async () => {},
      };
    },
    getHistoryForKey: async (k) => {
      const list = world.history.get(k) || [];
      let i = 0;
      return {
        next: async () => (i < list.length ? { value: list[i++], done: false } : { value: undefined, done: true }),
        close: async () => {},
      };
    },
    setEvent: (name, payload) => world.events.push({ name, payload: JSON.parse(payload.toString()) }),
    getTxTimestamp: () => ({ seconds: { low: 1700000000 + world.tx, high: 0 }, nanos: 5000000 }),
    getTxID: () => 'tx' + world.tx,
  };
  world.tx += 1;
  return { stub, clientIdentity: { getID: () => id, getMSPID: () => msp } };
}

const ADMIN = 'x509::CN=Admin,O=Org1', INV = 'x509::CN=User1,O=Org1', VER = 'x509::CN=Admin,O=Org2', OUT = 'x509::CN=User1,O=Org2';
const HASH = 'a'.repeat(64);

async function ready() {
  const cc = new EvidenceContract();
  const w = newWorld();
  await cc.InitLedger(ctxFor(w, ADMIN, 'Org1MSP'));
  await cc.AddInvestigator(ctxFor(w, ADMIN, 'Org1MSP'), INV);
  await cc.AddVerifier(ctxFor(w, ADMIN, 'Org1MSP'), VER);
  return { cc, w };
}
const as = (w, id) => ctxFor(w, id, id === VER || id === OUT ? 'Org2MSP' : 'Org1MSP');

test('the ledger can only be initialised once', async () => {
  const { cc, w } = await ready();
  await assert.rejects(() => cc.InitLedger(as(w, ADMIN)), /already initialised/);
});

test('only the administrator can grant roles', async () => {
  const { cc, w } = await ready();
  await assert.rejects(() => cc.AddInvestigator(as(w, INV), OUT), /Not authorised/);
});

test('an unauthorised identity cannot register evidence', async () => {
  const { cc, w } = await ready();
  await assert.rejects(() => cc.RegisterEvidence(as(w, OUT), 'CAS-1', 'QmX', HASH), /Not authorised/);
});

test('a verifier cannot register evidence but can read it', async () => {
  const { cc, w } = await ready();
  await assert.rejects(() => cc.RegisterEvidence(as(w, VER), 'CAS-1', 'QmX', HASH), /Not authorised/);
  await cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  const rec = JSON.parse(await cc.GetEvidence(as(w, VER), '1'));
  assert.strictEqual(rec.fileHash, HASH);
});

test('an unauthorised identity cannot read records', async () => {
  const { cc, w } = await ready();
  await cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await assert.rejects(() => cc.GetEvidence(as(w, OUT), '1'), /Not authorised/);
  await assert.rejects(() => cc.GetAllEvidence(as(w, OUT)), /Not authorised/);
});

test('an investigator registers evidence and numbers run in order', async () => {
  const { cc, w } = await ready();
  const a = JSON.parse(await cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmA', HASH));
  const b = JSON.parse(await cc.RegisterEvidence(as(w, ADMIN), 'CAS-2', 'QmB', 'b'.repeat(64)));
  assert.deepStrictEqual([a.evidenceId, b.evidenceId], [1, 2]);
  assert.strictEqual(JSON.parse(await cc.GetEvidenceCount(as(w, OUT))).count, 2);
  assert.strictEqual(JSON.parse(await cc.GetAllEvidence(as(w, VER))).length, 2);
  const rec = JSON.parse(await cc.GetEvidence(as(w, INV), '1'));
  assert.strictEqual(rec.custodian, INV);
  assert.ok(rec.timestamp > 1700000000000);
});

test('bad inputs are refused', async () => {
  const { cc, w } = await ready();
  await assert.rejects(() => cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', 'xyz'), /64 lowercase hex/);
  await assert.rejects(() => cc.RegisterEvidence(as(w, INV), '', 'QmX', HASH), /case number/);
  await assert.rejects(() => cc.GetEvidence(as(w, INV), '99'), /No such evidence/);
});

test('custody moves only from the current custodian to an authorised investigator', async () => {
  const { cc, w } = await ready();
  await cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await assert.rejects(() => cc.TransferCustody(as(w, ADMIN), '1', ADMIN), /Not custodian/);
  await assert.rejects(() => cc.TransferCustody(as(w, OUT), '1', ADMIN), /Not authorised/);
  await assert.rejects(() => cc.TransferCustody(as(w, INV), '1', OUT), /Recipient not authorised/);
  await cc.TransferCustody(as(w, INV), '1', ADMIN);
  assert.strictEqual(JSON.parse(await cc.GetEvidence(as(w, INV), '1')).custodian, ADMIN);
});

test('history lists each version of a record', async () => {
  const { cc, w } = await ready();
  await cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  await cc.TransferCustody(as(w, INV), '1', ADMIN);
  const h = JSON.parse(await cc.GetHistory(as(w, VER), '1'));
  assert.deepStrictEqual(h.map((x) => x.custodian), [INV, ADMIN]);
});

test('events are emitted for writes', async () => {
  const { cc, w } = await ready();
  await cc.RegisterEvidence(as(w, INV), 'CAS-1', 'QmX', HASH);
  assert.ok(w.events.some((e) => e.name === 'EvidenceRegistered' && e.payload.evidenceId === 1));
  assert.ok(w.events.some((e) => e.name === 'RoleGranted'));
});

test('helper methods are not exposed as transactions', () => {
  const names = Object.getOwnPropertyNames(EvidenceContract.prototype).filter((n) => !n.startsWith('_') && n !== 'constructor');
  assert.ok(names.includes('RegisterEvidence'));
  assert.ok(!names.some((n) => n.startsWith('_')));
});
