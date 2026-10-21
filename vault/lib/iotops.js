'use strict';
/**
 * Objective 4: IoT sensor evidence.
 * Readings are grouped into batches. Each batch is hashed into a Merkle root, encrypted with the chaos map
 * and stored in IPFS, and its root is anchored on the ledger in strict sequence by the device's gateway.
 */
const crypto = require('crypto');
const { crypt } = require('./chaos');
const merkle = require('./merkle');
const ipfs = require('./ipfs');
const { ApiError } = require('./errors');

const ZERO64 = '0'.repeat(64);
const GATEWAY = 'officerB';
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const r1 = (x) => Math.round(x * 10) / 10;
const readingHash = (r) => sha256hex(JSON.stringify([r.device, r.seq, r.t, r.kind, r.value]));
const batchLabel = (device, index) => `batch:${device}:${index}`;

function makeReadings(deviceId, startSeq, count, startTime) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    out.push({ device: deviceId, seq, t: startTime + seq * 1000, kind: 'temperature', value: Math.round((18 + Math.random() * 10) * 100) / 100 });
  }
  return out;
}

async function head(deviceId, deps) {
  try {
    return await deps.evaluate('officerA', 'MediaContract:LastBatch', deviceId);
  } catch (e) {
    if (/No such device/.test(e.message)) return null;
    throw e;
  }
}

async function ensureDevice(deviceId, deps) {
  if (await head(deviceId, deps)) return false;
  const accounts = await deps.accounts();
  const gateway = accounts.find((a) => a.key === GATEWAY);
  await deps.submit('officerA', 'MediaContract:RegisterDevice', deviceId, gateway.id);
  return true;
}

function batchFile(deviceId, index, readings) {
  const readingHashes = readings.map(readingHash);
  return { file: { deviceId, batchIndex: index, readingHashes, readings }, root: merkle.rootOf(readingHashes) };
}

/** Generates readings from a simulated sensor and anchors them in batches. */
async function simulate({ deviceId, readings, batchSize, key, deps }) {
  const count = Number(readings), size = Number(batchSize) || 500;
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw new ApiError(400, 'The number of readings must be between 1 and 100000.');
  if (!Number.isInteger(size) || size < 1 || size > 100000) throw new ApiError(400, 'The batch size must be between 1 and 100000.');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId || '')) throw new ApiError(400, 'The device ID must be 1 to 64 letters, digits, dots, dashes or underscores.');
  const created = await ensureDevice(deviceId, deps);
  const h = await head(deviceId, deps);
  let nextIndex = h.count + 1;
  const earlier = h.count ? await deps.evaluate('officerA', 'MediaContract:GetBatchChain', deviceId) : [];
  const startSeq = earlier.reduce((sum, b) => sum + b.readingCount, 0);
  const all = makeReadings(deviceId, startSeq, count, Date.now());
  const batches = [];
  const T = { hash: 0, encrypt: 0, ipfs: 0, replicate: 0, ledger: 0 };
  const started = performance.now();
  for (let off = 0; off < all.length; off += size) {
    const chunk = all.slice(off, off + size);
    const index = nextIndex++;
    let t = performance.now();
    const built = batchFile(deviceId, index, chunk);
    T.hash += performance.now() - t;
    t = performance.now();
    const cipher = crypt(key, batchLabel(deviceId, index), Buffer.from(JSON.stringify(built.file)));
    T.encrypt += performance.now() - t;
    const stored = await ipfs.add(cipher);
    T.ipfs += stored.premiseMs;
    T.replicate += stored.cloudMs;
    t = performance.now();
    const tx = await deps.submit(GATEWAY, 'MediaContract:AnchorBatch', deviceId, String(index), built.root, String(chunk.length), stored.cid);
    const ledgerMs = performance.now() - t;
    T.ledger += ledgerMs;
    batches.push({ index, readings: chunk.length, merkleRoot: built.root, cid: stored.cid, batchHash: tx.result.batchHash, txId: tx.txId, ledgerMs: r1(ledgerMs) });
  }
  const timings = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, r1(v)]));
  timings.total = r1(performance.now() - started);
  return { deviceId, deviceCreated: created, readings: count, batchSize: size, batches, timings };
}

async function fetchBatch(deviceId, b, key) {
  const got = await ipfs.cat(b.cid);
  if (!got) return { found: false };
  const cidOk = (await ipfs.hashOnly(got.data)) === b.cid;
  let file = null;
  try { file = JSON.parse(crypt(key, batchLabel(deviceId, b.batchIndex), got.data).toString('utf8')); } catch (e) { /* damaged or wrong key */ }
  return { found: true, cidOk, file: file && Array.isArray(file.readings) ? file : null, tier: got.tier };
}

/** Walks the whole sequence for a device: the hash chain, then every stored batch against its anchored root. */
async function verifyDevice({ acct, deviceId, key, deps }) {
  const started = performance.now();
  const chain = await deps.evaluate(acct, 'MediaContract:GetBatchChain', deviceId);
  const out = { deviceId, batches: chain.length, ok: true, chainOk: true, results: [], firstBad: null };
  let prev = ZERO64;
  for (const b of chain) {
    const r = { index: b.batchIndex, ok: true, reasons: [], changedReadings: [] };
    const expected = sha256hex(JSON.stringify([prev, b.merkleRoot, b.batchIndex, deviceId]));
    if (b.prevHash !== prev || b.batchHash !== expected) { r.ok = false; r.reasons.push('the batch hash chain is broken here'); out.chainOk = false; }
    prev = b.batchHash;
    const fb = await fetchBatch(deviceId, b, key);
    if (!fb.found) { r.ok = false; r.reasons.push('the stored batch is missing'); }
    else if (!fb.cidOk) { r.ok = false; r.reasons.push('the stored batch no longer matches its content ID'); }
    else if (!fb.file) { r.ok = false; r.reasons.push('the stored batch could not be decrypted'); }
    else {
      const stored = fb.file.readingHashes || [];
      const calc = fb.file.readings.map(readingHash);
      if (merkle.rootOf(stored) !== b.merkleRoot) { r.ok = false; r.reasons.push('the stored hashes no longer produce the anchored Merkle root'); }
      else {
        r.changedReadings = calc.map((h, i) => (h !== stored[i] ? i : -1)).filter((i) => i >= 0);
        if (r.changedReadings.length || calc.length !== stored.length) { r.ok = false; r.reasons.push('readings differ from their anchored hashes'); }
      }
    }
    if (!r.ok) { out.ok = false; if (out.firstBad === null) out.firstBad = r.index; }
    out.results.push(r);
  }
  out.ms = r1(performance.now() - started);
  return out;
}

/** The decrypted batch, as a file someone could keep, share or edit. */
async function exportBatch({ acct, deviceId, index, key, deps }) {
  const b = await deps.evaluate(acct, 'MediaContract:GetBatch', deviceId, String(index));
  const fb = await fetchBatch(deviceId, b, key);
  if (!fb.found || !fb.cidOk || !fb.file) throw new ApiError(409, 'The stored batch could not be read back intact.');
  return JSON.stringify(fb.file, null, 2);
}

/** Checks a batch file you hold against the anchored root. */
async function checkBatchFile({ acct, deviceId, index, key, text, deps }) {
  const b = await deps.evaluate(acct, 'MediaContract:GetBatch', deviceId, String(index));
  const fb = await fetchBatch(deviceId, b, key);
  if (!fb.found || !fb.cidOk || !fb.file) throw new ApiError(409, 'The stored batch could not be read back intact, so it cannot be compared.');
  const stored = fb.file.readingHashes;
  if (merkle.rootOf(stored) !== b.merkleRoot) throw new ApiError(409, 'The stored batch does not match its anchored root.');
  let supplied;
  try { supplied = JSON.parse(text); } catch (e) { throw new ApiError(400, 'The supplied batch file is not valid JSON.'); }
  if (!Array.isArray(supplied.readings)) throw new ApiError(400, 'The supplied file has no readings.');
  const calc = supplied.readings.map(readingHash);
  const changed = [];
  for (let i = 0; i < Math.max(calc.length, stored.length); i++) if (calc[i] !== stored[i]) changed.push(i);
  const rootNew = calc.length ? merkle.rootOf(calc) : null;
  return {
    deviceId, batchIndex: Number(index), readings: { expected: stored.length, found: calc.length }, changedReadings: changed,
    rootMatch: rootNew === b.merkleRoot, ledgerRoot: b.merkleRoot, computedRoot: rootNew, ok: rootNew === b.merkleRoot,
  };
}

module.exports = { simulate, verifyDevice, exportBatch, checkBatchFile, readingHash, head };
