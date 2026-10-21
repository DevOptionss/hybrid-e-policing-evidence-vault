'use strict';

// A small in memory stand in for the Fabric ledger, so chaincode logic can be tested without a network.
function newWorld() {
  return { state: new Map(), history: new Map(), events: [], tx: 0 };
}

function ctxFor(world, id, msp) {
  world.tx += 1;
  const txId = 'tx' + world.tx;
  const stub = {
    getState: async (k) => (world.state.has(k) ? Buffer.from(world.state.get(k)) : Buffer.alloc(0)),
    putState: async (k, v) => {
      world.state.set(k, Buffer.from(v));
      if (!world.history.has(k)) world.history.set(k, []);
      world.history.get(k).push({ txId, timestamp: { seconds: { low: 1700000000 + world.tx, high: 0 }, nanos: 0 }, isDelete: false, value: Buffer.from(v) });
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
    getTxID: () => txId,
  };
  return { stub, clientIdentity: { getID: () => id, getMSPID: () => msp } };
}

module.exports = { newWorld, ctxFor };
