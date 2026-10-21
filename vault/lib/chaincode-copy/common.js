'use strict';

const crypto = require('crypto');

const HEX64 = /^[0-9a-f]{64}$/;
const ZERO64 = '0'.repeat(64);
const COUNT_KEY = 'COUNT';
const ADMIN_KEY = 'ADMIN';
const READ_ROLES = ['admin', 'investigator', 'verifier'];
const WRITE_ROLES = ['admin', 'investigator'];

const roleKey = (id) => 'ROLE~' + id;
const evidenceKey = (n) => 'EVID~' + String(n).padStart(8, '0');
const custodyKey = (id, n) => 'CUST~' + String(id).padStart(8, '0') + '~' + String(n).padStart(6, '0');

const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v.toNumber === 'function') return v.toNumber();
  if (v && typeof v.low === 'number') return v.low + (v.high || 0) * 4294967296;
  return Number(v) || 0;
}

function timestampMs(ts) {
  if (!ts) return 0;
  return toNum(ts.seconds) * 1000 + Math.floor(toNum(ts.nanos) / 1e6);
}

const text = (bytes) => Buffer.from(bytes).toString('utf8');

async function roleOf(ctx, id) {
  const bytes = await ctx.stub.getState(roleKey(id));
  return bytes && bytes.length ? text(bytes) : null;
}

async function requireRole(ctx, allowed) {
  const role = await roleOf(ctx, ctx.clientIdentity.getID());
  if (!role || !allowed.includes(role)) throw new Error('Not authorised');
  return role;
}

async function loadEvidence(ctx, evidenceId) {
  const n = parseInt(evidenceId, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error('No such evidence');
  const bytes = await ctx.stub.getState(evidenceKey(n));
  if (!bytes || !bytes.length) throw new Error('No such evidence');
  return JSON.parse(text(bytes));
}

/**
 * One link in the chain of custody. The hash covers the previous link, the evidence number,
 * who gave custody up, who received it, the transaction time and the transaction ID.
 * The first link is chained to the SHA 256 hash of the evidence file itself.
 */
function custodyHash(prev, evidenceId, from, to, timeMs, txId) {
  return sha256hex(JSON.stringify([prev, evidenceId, from, to, timeMs, txId]));
}

/** Creates an evidence record with its first custody link. Used by every kind of registration. */
async function createEvidence(ctx, { caseId, cid, fileHash, eventName, eventExtra }) {
  if (!caseId || caseId.length > 200) throw new Error('A case number of up to 200 characters is required');
  if (!cid || cid.length > 120) throw new Error('A content ID of up to 120 characters is required');
  if (!HEX64.test(fileHash || '')) throw new Error('The file hash must be 64 lowercase hex characters');

  const countBytes = await ctx.stub.getState(COUNT_KEY);
  const evidenceId = parseInt(countBytes && countBytes.length ? text(countBytes) : '0', 10) + 1;
  const id = ctx.clientIdentity.getID();
  const time = timestampMs(ctx.stub.getTxTimestamp());
  const txId = ctx.stub.getTxID();
  const entryHash = custodyHash(fileHash, evidenceId, '', id, time, txId);

  const record = {
    evidenceId, caseId, cid, fileHash,
    custodian: id, custodianMsp: ctx.clientIdentity.getMSPID(),
    timestamp: time, txId, custodyHead: entryHash, custodyCount: 1,
  };
  const entry = { n: 0, prev: fileHash, from: '', to: id, time, txId, hash: entryHash };

  await ctx.stub.putState(evidenceKey(evidenceId), Buffer.from(JSON.stringify(record)));
  await ctx.stub.putState(custodyKey(evidenceId, 0), Buffer.from(JSON.stringify(entry)));
  await ctx.stub.putState(COUNT_KEY, Buffer.from(String(evidenceId)));
  ctx.stub.setEvent(eventName, Buffer.from(JSON.stringify({
    evidenceId, caseId, cid, fileHash, by: id, time, custodyHash: entryHash, ...(eventExtra || {}),
  })));
  return record;
}

async function readRange(ctx, start, end) {
  const out = [];
  const iterator = await ctx.stub.getStateByRange(start, end);
  for (;;) {
    const res = await iterator.next();
    if (res.value && res.value.value && res.value.value.length) out.push(JSON.parse(text(res.value.value)));
    if (res.done) {
      await iterator.close();
      break;
    }
  }
  return out;
}

module.exports = {
  HEX64, ZERO64, COUNT_KEY, ADMIN_KEY, READ_ROLES, WRITE_ROLES,
  roleKey, evidenceKey, custodyKey, sha256hex, timestampMs, text,
  roleOf, requireRole, loadEvidence, custodyHash, createEvidence, readRange,
};
