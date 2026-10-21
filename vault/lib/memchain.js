'use strict';
/**
 * Stand in ledger used by "node server.js --demo" and for automated checks.
 * It runs the real chaincode logic (a copy of evidence-cc/lib/evidence.js) against an in memory
 * world state, so roles, refusals and custody rules behave exactly as on Fabric.
 * It is NOT a blockchain and is never used when the Fabric network is available.
 */
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'fabric-contract-api') return { Contract: class Contract {} };
  return originalLoad.call(this, request, ...rest);
};
const EvidenceContract = require('./chaincode-copy/evidence.js');
const MediaContract = require('./chaincode-copy/media.js');
Module._load = originalLoad;

const ACCOUNTS = [
  { key: 'officerA', name: 'Investigator A (administrator)', msp: 'Org1MSP', id: 'x509::/C=US/OU=admin/CN=Admin@org1.example.com' },
  { key: 'officerB', name: 'Investigator B', msp: 'Org1MSP', id: 'x509::/C=US/OU=client/CN=User1@org1.example.com' },
  { key: 'verifier', name: 'Verifier (read only)', msp: 'Org2MSP', id: 'x509::/C=US/OU=admin/CN=Admin@org2.example.com' },
  { key: 'outsider', name: 'Outsider (not authorised)', msp: 'Org2MSP', id: 'x509::/C=US/OU=client/CN=User1@org2.example.com' },
];

function create() {
  const contracts = { EvidenceContract: new EvidenceContract(), MediaContract: new MediaContract() };
  const world = { state: new Map(), history: new Map(), events: [], tx: 0, block: 0 };
  const log = [];

  function ctxFor(acct, txId) {
    const a = ACCOUNTS.find((x) => x.key === acct);
    if (!a) throw new Error('Unknown account');
    const stub = {
      getState: async (k) => (world.state.has(k) ? Buffer.from(world.state.get(k)) : Buffer.alloc(0)),
      putState: async (k, v) => {
        world.state.set(k, Buffer.from(v));
        if (!world.history.has(k)) world.history.set(k, []);
        world.history.get(k).push({ txId, timestamp: { seconds: Math.floor(Date.now() / 1000), nanos: 0 }, isDelete: false, value: Buffer.from(v) });
      },
      getStateByRange: async (s, e) => {
        const keys = [...world.state.keys()].filter((k) => k >= s && k < e).sort();
        let i = 0;
        return { next: async () => (i < keys.length ? { value: { value: world.state.get(keys[i++]) }, done: false } : { value: undefined, done: true }), close: async () => {} };
      },
      getHistoryForKey: async (k) => {
        const list = world.history.get(k) || [];
        let i = 0;
        return { next: async () => (i < list.length ? { value: list[i++], done: false } : { value: undefined, done: true }), close: async () => {} };
      },
      setEvent: (name, payload) => { stub._event = { name, payload: JSON.parse(payload.toString()) }; },
      getTxTimestamp: () => ({ seconds: Math.floor(Date.now() / 1000), nanos: 0 }),
      getTxID: () => txId,
    };
    return { stub, clientIdentity: { getID: () => a.id, getMSPID: () => a.msp } };
  }

  async function run(acct, fn, args, commit) {
    const txId = 'memtx' + String(++world.tx).padStart(6, '0') + Math.random().toString(16).slice(2, 10);
    const snapshot = commit ? null : new Map(world.state);
    const histSnapshot = commit ? null : new Map([...world.history].map(([k, v]) => [k, v.slice()]));
    const ctx = ctxFor(acct, txId);
    try {
      const [contractName, fnName] = fn.includes(':') ? fn.split(':') : ['EvidenceContract', fn];
      const cc = contracts[contractName];
      if (!cc || typeof cc[fnName] !== 'function' || fnName.startsWith('_')) throw new Error('Unknown function ' + fn);
      const out = await cc[fnName](ctx, ...args);
      if (commit) {
        world.block += 1;
        if (ctx.stub._event) world.events.push({ blockNumber: world.block, txId, name: ctx.stub._event.name, payload: ctx.stub._event.payload, time: Date.now() });
        return { result: out, txId, blockNumber: world.block };
      }
      return { result: out };
    } finally {
      if (!commit) { world.state = snapshot; world.history = histSnapshot; }
    }
  }

  const parse = (s) => (s ? JSON.parse(s) : null);

  return {
    kind: 'memory',
    channel: 'memory',
    chaincode: 'evidence (stand in)',
    async init() {
      if (!world.state.has('ADMIN')) {
        await run('officerA', 'InitLedger', [], true);
        const idOf = async (k) => parse((await run(k, 'WhoAmI', [], false)).result).id;
        await run('officerA', 'AddInvestigator', [await idOf('officerB')], true);
        await run('officerA', 'AddVerifier', [await idOf('verifier')], true);
      }
    },
    async accounts() {
      const out = [];
      for (const a of ACCOUNTS) {
        const w = parse((await run(a.key, 'WhoAmI', [], false)).result);
        out.push({ key: a.key, name: a.name, id: w.id, mspId: w.mspId, role: w.role });
      }
      return out;
    },
    async height() { return world.block + 1; },
    async evaluate(acct, fn, ...args) { return parse((await run(acct, fn, args, false)).result); },
    async submit(acct, fn, ...args) {
      const r = await run(acct, fn, args, true);
      return { result: parse(r.result), txId: r.txId, blockNumber: r.blockNumber };
    },
    events() { return world.events.slice(); },
    describeError(e) { return e.message || String(e); },
  };
}

module.exports = { create };
