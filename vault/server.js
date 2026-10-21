'use strict';
/**
 * Evidence Vault server (Objective 3 demonstration on Hyperledger Fabric).
 *
 *   node server.js           uses the Fabric test network and your IPFS node
 *   node server.js --demo    uses an in memory stand in ledger (no Fabric needed)
 *
 * Then open http://localhost:3000
 *
 * Evidence is hashed, encrypted with the chaos map, stored on IPFS, and its hash and content ID
 * are registered through the "evidence" chaincode. Roles and refusals come from the chaincode.
 * Objective 4 adds segmented media evidence (CCTV, multimedia) and sequenced IoT batches, and an optional
 * cloud IPFS node (set CLOUD_IPFS_API) that receives an encrypted replica of everything.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const ipfs = require('./lib/ipfs');
const { crypt } = require('./lib/chaos');
const custody = require('./lib/custody');
const { ApiError } = require('./lib/errors');
const mediaOps = require('./lib/mediaops');
const iotOps = require('./lib/iotops');

const PORT = Number(process.env.PORT) || 3000;
const DEMO = process.argv.includes('--demo') || (process.env.CHAIN || '').toLowerCase() === 'memory';
const META_FILE = path.join(__dirname, 'vault_meta.json');
const MAX_UPLOAD = 200 * 1024 * 1024;

const chain = (DEMO ? require('./lib/memchain') : require('./lib/fabric')).create();

/* ------------------------------------------------------------- chaos map cipher */
const chaosCrypt = (data, master) => crypt(master, 'file', data);   // Objective 3 files use the label 'file'

function parseKey(raw) {
  const v = parseFloat(raw);
  if (!(v > 0 && v < 1)) throw new ApiError(400, 'The session key must be a number greater than 0 and less than 1, for example 0.3141592653589793.');
  return String(raw).trim();
}

function flipBit(buf) {
  if (!buf.length) throw new ApiError(400, 'The stored file is empty, so there is nothing to alter.');
  const b = Buffer.from(buf);
  const i = Math.floor(b.length / 2);
  b[i] ^= 1;
  return { data: b, index: i };
}

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ms = (t) => Math.round((performance.now() - t) * 10) / 10;

/* ------------------------------------------------------------------------ IPFS */
async function ipfsAdd(buf, onlyHash) { return onlyHash ? ipfs.hashOnly(buf) : (await ipfs.add(buf)).cid; }
async function ipfsCat(cid) { const got = await ipfs.cat(cid); return got ? got.data : null; }

/* ---------------------------------------------------------------- sidecar meta */
function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMeta(evidenceId, cid, info) {
  const meta = loadMeta();
  meta[evidenceId + ':' + cid] = info;
  fs.writeFileSync(META_FILE, JSON.stringify(meta));
}

/* ---------------------------------------------------------------- chain access */
let queue = Promise.resolve();
function serial(fn) {                       // one write at a time avoids ledger read conflicts
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function refuse(e) {
  const reason = chain.describeError(e);
  const known = /Not authorised|Not custodian|Recipient not authorised|No such|already|out of sequence|Not a manifest|must be|required|between|evidence type|Merkle root|capture end/i.test(reason);
  return new ApiError(known ? 403 : 502, (known ? 'Refused by the chaincode: ' : 'Ledger error: ') + reason);
}
async function evaluate(acct, fn, ...args) {
  try { return await chain.evaluate(acct, fn, ...args); } catch (e) { throw refuse(e); }
}
async function submit(acct, fn, ...args) {
  return serial(async () => { try { return await chain.submit(acct, fn, ...args); } catch (e) { throw refuse(e); } });
}

let accountCache = null;
async function accounts() {
  if (!accountCache) accountCache = await chain.accounts();
  return accountCache;
}
const nameOfId = (accs, id) => { const a = accs.find((x) => x.id === id); return a ? a.name : id; };

async function readRecords(acct) {
  const list = await evaluate(acct, 'GetAllEvidence');
  const accs = await accounts();
  const meta = loadMeta();
  return list.map((e) => {
    const m = meta[e.evidenceId + ':' + e.cid] || {};
    return {
      evidenceId: e.evidenceId, caseId: e.caseId, cid: e.cid, fileHash: e.fileHash,
      custodian: e.custodian, custodianName: nameOfId(accs, e.custodian), time: e.timestamp,
      fileName: m.fileName || 'evidence-' + e.evidenceId, fileSize: m.fileSize || 0, mime: m.mime || 'application/octet-stream', kind: m.kind || 'file',
    };
  });
}
async function readRecord(acct, id) {
  const rec = (await readRecords(acct)).find((r) => r.evidenceId === Number(id));
  if (!rec) throw new ApiError(404, 'There is no evidence with that number.');
  return rec;
}
const chainNote = () => (DEMO
  ? 'Read from the stand in ledger, which runs the same chaincode logic as Fabric.'
  : 'Read from the Fabric peers, which validate and hash link every block.');

/* ------------------------------------------------------------------- endpoints */
async function apiStatus() {
  const out = { ready: false, demo: DEMO, ipfs: { ok: false }, chain: { ok: false, kind: chain.kind, channel: chain.channel, chaincode: chain.chaincode }, accounts: [] };
  out.tiers = await ipfs.tiers();
  out.ipfs = { ok: out.tiers.premise.ok, version: out.tiers.premise.version };
  const mu = process.memoryUsage();
  out.rss = mu.rss;
  out.mem = { rss: mu.rss, heapUsed: mu.heapUsed, external: mu.external, arrayBuffers: mu.arrayBuffers };
  try {
    await chain.init();
    const accs = await chain.accounts();
    accountCache = accs;
    out.accounts = accs.map((a) => ({
      key: a.key, name: a.name, address: a.id, mspId: a.mspId, role: a.role,
      canWrite: a.role === 'admin' || a.role === 'investigator',
      canRead: ['admin', 'investigator', 'verifier'].includes(a.role),
    }));
    out.chain.ok = true;
    out.chain.height = await chain.height();
  } catch (e) {
    out.error = chain.describeError(e);
  }
  out.ready = out.ipfs.ok && out.chain.ok && out.accounts.length > 0;
  return out;
}

async function apiLedger() {
  const accs = await accounts();
  const recTime = {};
  try { for (const r of await readRecords('officerA')) recTime[r.evidenceId] = r.time; } catch (e) { /* ignore */ }
  const blocks = chain.events().map((ev) => {
    const p = ev.payload || {};
    let title = ev.name, detail = '', actor = '', time = ev.time || 0;
    if (ev.name === 'EvidenceRegistered') {
      title = 'Registered evidence ' + p.evidenceId + ', ' + p.caseId;
      detail = 'Content ID ' + p.cid; actor = nameOfId(accs, p.by); time = p.time || recTime[p.evidenceId] || time;
    } else if (ev.name === 'CustodyTransferred') {
      title = 'Custody of evidence ' + p.evidenceId + ' passed on';
      detail = 'New custodian: ' + nameOfId(accs, p.to); actor = nameOfId(accs, p.from);
    } else if (ev.name === 'RoleGranted') {
      title = 'Role granted: ' + p.role; detail = nameOfId(accs, p.id);
    } else if (ev.name === 'ManifestRegistered') {
      title = 'Registered ' + p.evidenceType + ' evidence ' + p.evidenceId + ', ' + p.caseId;
      detail = p.segmentCount + ' segments, Merkle root ' + String(p.merkleRoot).slice(0, 16) + '...'; actor = nameOfId(accs, p.by);
    } else if (ev.name === 'DeviceRegistered') {
      title = 'Device registered: ' + p.deviceId; detail = 'Gateway: ' + nameOfId(accs, p.gateway);
    } else if (ev.name === 'BatchAnchored') {
      title = 'Anchored batch ' + p.batchIndex + ' for ' + p.deviceId; detail = p.readingCount + ' readings, batch hash ' + String(p.batchHash).slice(0, 16) + '...';
    }
    if (p.time) time = p.time;
    return { index: ev.blockNumber, title, detail, actor, hash: ev.txId, prev: '', time };
  });
  const height = await chain.height();
  return { blocks, chain: { ok: true, height, note: chainNote() } };
}

async function apiSave(acct, h, body) {
  if (!body.length) throw new ApiError(400, 'The file is empty.');
  const caseId = decodeURIComponent(h['x-case'] || '').trim() || 'CASE';
  const name = decodeURIComponent(h['x-name'] || '') || 'evidence';
  const mime = h['x-mime'] || 'application/octet-stream';
  const x0 = parseKey(h['x-key']);
  const steps = [];

  let t = performance.now();
  const fileHash = sha256hex(body);
  steps.push(ms(t));

  await evaluate(acct, 'RegisterEvidence', caseId, 'preflight', fileHash);   // the chaincode checks the role first

  t = performance.now();
  const cipher = chaosCrypt(body, x0);
  steps.push(ms(t));

  t = performance.now();
  const cid = await ipfsAdd(cipher);
  steps.push(ms(t));

  t = performance.now();
  const tx = await submit(acct, 'RegisterEvidence', caseId, cid, fileHash);
  steps.push(ms(t));

  saveMeta(tx.result.evidenceId, cid, { fileName: name, fileSize: body.length, mime });
  return { evidenceId: tx.result.evidenceId, fileHash, cid, txId: tx.txId, blockNumber: tx.blockNumber, steps };
}

async function apiCheckFile(acct, h, body) {
  if (!body.length) throw new ApiError(400, 'The file is empty.');
  const rec = await readRecord(acct, h['x-id']);
  const local = sha256hex(body);
  return { chain: { ok: true, note: chainNote() }, hashOk: local === rec.fileHash, local, ledger: rec.fileHash };
}

async function vaultRead(rec, x0) {
  const result = { chain: { ok: true, note: chainNote() }, ledger: rec.fileHash };
  const cipher = await ipfsCat(rec.cid);
  if (!cipher) return { result: { ...result, missing: true }, plain: null };
  const cidNow = await ipfsAdd(cipher, true);
  const plain = chaosCrypt(cipher, x0);
  const plainHash = sha256hex(plain);
  return { result: { ...result, missing: false, cidNow, cidOk: cidNow === rec.cid, hashOk: plainHash === rec.fileHash, plainHash }, plain };
}
async function apiCheckVault(acct, h) {
  const x0 = parseKey(h['x-key']);
  return (await vaultRead(await readRecord(acct, h['x-id']), x0)).result;
}
async function apiRetrieve(acct, h) {
  const x0 = parseKey(h['x-key']);
  const rec = await readRecord(acct, h['x-id']);
  const { result, plain } = await vaultRead(rec, x0);
  if (!plain || !result.cidOk || !result.hashOk) throw new ApiError(409, 'Retrieval blocked: the integrity check failed.');
  return { data: plain, mime: rec.mime };
}
async function apiTampered(acct, h) {
  const x0 = parseKey(h['x-key']);
  const rec = await readRecord(acct, h['x-id']);
  const cipher = await ipfsCat(rec.cid);
  if (!cipher) throw new ApiError(404, 'The stored copy is missing, so a test copy cannot be made.');
  const flipped = flipBit(chaosCrypt(cipher, x0));
  return { data: flipped.data, mime: rec.mime, index: flipped.index };
}
async function apiTransfer(acct, h) {
  const accs = await accounts();
  const target = accs.find((a) => a.key === (acct === 'officerA' ? 'officerB' : 'officerA'));
  const tx = await submit(acct, 'TransferCustody', String(h['x-id']), target.id);
  return { toName: target.name, txId: tx.txId, blockNumber: tx.blockNumber };
}

async function apiAttack(kind, h) {
  const accs = await accounts();
  const rec = await readRecord('officerA', h['x-id']);
  const lines = [];
  let select = null, data = {};
  if (kind === 'altered_copy' || kind === 'swap_copy') {
    const cipher = await ipfsCat(rec.cid);
    if (!cipher) throw new ApiError(404, 'The stored copy is missing, so there is nothing to alter.');
    const flipped = flipBit(cipher);
    const alteredCid = await ipfsAdd(flipped.data);
    lines.push('A copy of the stored ciphertext for evidence ' + rec.evidenceId + ' was altered at byte ' + flipped.index + ' and added to IPFS.');
    lines.push('Registered content ID: ' + rec.cid);
    lines.push('Altered content ID: ' + alteredCid);
    data = { registeredCid: rec.cid, alteredCid };
    if (kind === 'altered_copy') {
      const again = await ipfsCat(rec.cid);
      data.originalIntact = Boolean(again && again.equals(cipher));
      lines.push('The identifiers differ, so the record still points at the original copy. The original is unchanged: ' + (data.originalIntact ? 'yes' : 'no') + '.');
    } else {
      const tx = await submit('officerA', 'RegisterEvidence', rec.caseId + ' (swapped copy)', alteredCid, rec.fileHash);
      saveMeta(tx.result.evidenceId, alteredCid, { fileName: rec.fileName + ' (swapped copy)', fileSize: rec.fileSize, mime: rec.mime });
      select = tx.result.evidenceId;
      lines.push('A new record, evidence ' + select + ', now points at the altered copy but carries the original file hash.');
      lines.push('Run Check vault copy on evidence ' + select + ' to see the swap caught.');
    }
  } else if (kind === 'edit_attempt') {
    lines.push('The chaincode has no function that edits or deletes a registered record. The only change allowed is a custody handover, and only by the current custodian.');
    const refusals = [];
    for (const a of accs) {
      if (a.id === rec.custodian) continue;
      try {
        await submit(a.key, 'TransferCustody', String(rec.evidenceId), rec.custodian);
        lines.push(a.name + ': the handover was accepted.');
      } catch (e) {
        refusals.push({ account: a.name, message: e.message });
        lines.push(a.name + ' tried to take custody of evidence ' + rec.evidenceId + ' and was refused. ' + e.message);
      }
    }
    data = { refusals };
  } else {
    throw new ApiError(400, 'Unknown attack.');
  }
  return { lines, select, data };
}

/* ----------------------------------------------------------------- HTTP server */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Acct, X-Key, X-Case, X-Name, X-Mime, X-Id, X-Type, X-Segment, X-Capture-Start, X-Capture-End, X-Device, X-Batch',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Flipped-Byte',
};
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, ...CORS });
  res.end(body);
}
function sendBytes(res, data, mime, extra) {
  res.writeHead(200, { 'Content-Type': mime || 'application/octet-stream', 'Content-Length': data.length, ...CORS, ...(extra || {}) });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { reject(new ApiError(413, 'That file is larger than the ' + (MAX_UPLOAD / 1048576) + ' MB limit.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ----------------------------------------------------------- chain of custody */
async function apiCustody(acct, h) {
  const accs = await accounts();
  const trail = await evaluate(acct, 'GetCustodyTrail', String(h['x-id']));
  trail.entries = trail.entries.map((e) => ({ ...e, fromName: e.from ? nameOfId(accs, e.from) : '(registration)', toName: nameOfId(accs, e.to) }));
  trail.independent = custody.verifyTrail(trail);
  return trail;
}

/* ------------------------------------------------------- Objective 4 endpoints */
const deps = { evaluate, submit, accounts: () => accounts(), saveMeta };
const needKey = (h) => {
  const k = String(h['x-key'] || '');
  if (k.length < 4) throw new ApiError(400, 'A session key is required.');
  return k;
};
async function readJson(req) {
  const b = await readBody(req);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch (e) { throw new ApiError(400, 'The request body is not valid JSON.'); }
}
const cleanup = (f) => fs.promises.unlink(f).catch(() => {});
const optNum = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Streams an upload straight to a temporary file, so large recordings never sit in memory. */
async function uploadToTemp(req, limit) {
  const file = path.join(os.tmpdir(), 'vault-' + crypto.randomBytes(8).toString('hex'));
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) req.destroy(new ApiError(413, 'That file is larger than the upload limit.')); });
  try {
    await pipeline(req, fs.createWriteStream(file));
  } catch (e) {
    await cleanup(file);
    throw e instanceof ApiError ? e : new ApiError(400, 'The upload did not complete.');
  }
  return file;
}

async function apiMediaIngest(acct, h, req) {
  const b = await readJson(req);
  return mediaOps.ingestFile({
    acct, filePath: b.path, caseId: String(b.caseId || 'CASE'), evidenceType: b.type, key: needKey(h),
    segmentSize: optNum(b.segmentSize), captureStart: optNum(b.captureStart), captureEnd: optNum(b.captureEnd),
    fileName: b.fileName, mime: b.mime, deps,
  });
}
async function apiMediaUpload(acct, h, req) {
  const key = needKey(h);
  const file = await uploadToTemp(req, 4 * 1024 ** 3);
  try {
    return await mediaOps.ingestFile({
      acct, filePath: file, caseId: decodeURIComponent(h['x-case'] || '') || 'CASE', evidenceType: h['x-type'] || 'cctv', key,
      segmentSize: optNum(h['x-segment']), captureStart: optNum(h['x-capture-start']), captureEnd: optNum(h['x-capture-end']),
      fileName: decodeURIComponent(h['x-name'] || '') || undefined, mime: h['x-mime'], deps,
    });
  } finally { await cleanup(file); }
}
async function apiMediaVerify(acct, h) {
  return mediaOps.verifyVault({ acct, evidenceId: h['x-id'], key: needKey(h), deps });
}
async function apiMediaCheckFile(acct, h, req) {
  const key = needKey(h);
  const file = await uploadToTemp(req, 4 * 1024 ** 3);
  try { return await mediaOps.checkFile({ acct, evidenceId: h['x-id'], key, filePath: file, deps }); } finally { await cleanup(file); }
}
async function apiMediaAttack(kind, h) {
  if (kind !== 'manifest_edit') throw new ApiError(400, 'Unknown attack.');
  return mediaOps.attackManifestEdit({ evidenceId: h['x-id'], key: needKey(h), deps });
}
async function apiIotSimulate(acct, h, req) {
  const b = await readJson(req);
  return iotOps.simulate({ deviceId: b.deviceId, readings: b.readings, batchSize: b.batchSize, key: needKey(h), deps });
}
async function apiIotVerify(acct, h, req) {
  const b = await readJson(req);
  return iotOps.verifyDevice({ acct, deviceId: b.deviceId, key: needKey(h), deps });
}
async function apiIotRawAnchor(h, req) {
  const b = await readJson(req);
  const tx = await submit(b.acct || 'officerB', 'MediaContract:AnchorBatch', String(b.deviceId), String(b.index), String(b.root), String(b.count), String(b.cid));
  return tx.result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const h = req.headers;
  const acct = h['x-acct'] || 'officerA';
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') {
        const f = path.join(__dirname, 'index.html');
        if (!fs.existsSync(f)) throw new ApiError(404, 'index.html was not found next to server.js.');
        const body = fs.readFileSync(f);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
        return res.end(body);
      }
      if (p === '/api/status') return sendJson(res, 200, await apiStatus());
      if (p === '/api/records') return sendJson(res, 200, await readRecords(acct));
      if (p === '/api/ledger') return sendJson(res, 200, await apiLedger());
      if (p === '/api/custody') return sendJson(res, 200, await apiCustody(acct, h));
      if (p === '/api/retrieve') { const r = await apiRetrieve(acct, h); return sendBytes(res, r.data, r.mime); }
      if (p === '/api/tampered') { const r = await apiTampered(acct, h); return sendBytes(res, r.data, r.mime, { 'X-Flipped-Byte': String(r.index) }); }
      if (p === '/api/iot/export') {
        const text = await iotOps.exportBatch({ acct, deviceId: url.searchParams.get('device'), index: url.searchParams.get('batch'), key: needKey(h), deps });
        return sendBytes(res, Buffer.from(text), 'application/json');
      }
    }
    if (req.method === 'POST') {
      if (p === '/api/save') return sendJson(res, 200, await apiSave(acct, h, await readBody(req)));
      if (p === '/api/check-file') return sendJson(res, 200, await apiCheckFile(acct, h, await readBody(req)));
      if (p === '/api/check-vault') return sendJson(res, 200, await apiCheckVault(acct, h));
      if (p === '/api/transfer') return sendJson(res, 200, await apiTransfer(acct, h));
      if (p === '/api/attack') return sendJson(res, 200, await apiAttack(url.searchParams.get('kind'), h));
      if (p === '/api/media/ingest') return sendJson(res, 200, await apiMediaIngest(acct, h, req));
      if (p === '/api/media/upload') return sendJson(res, 200, await apiMediaUpload(acct, h, req));
      if (p === '/api/media/verify') return sendJson(res, 200, await apiMediaVerify(acct, h));
      if (p === '/api/media/check-file') return sendJson(res, 200, await apiMediaCheckFile(acct, h, req));
      if (p === '/api/media/attack') return sendJson(res, 200, await apiMediaAttack(url.searchParams.get('kind'), h));
      if (p === '/api/iot/simulate') return sendJson(res, 200, await apiIotSimulate(acct, h, req));
      if (p === '/api/iot/verify') return sendJson(res, 200, await apiIotVerify(acct, h, req));
      if (p === '/api/iot/check-batch') {
        const text = (await readBody(req)).toString('utf8');
        return sendJson(res, 200, await iotOps.checkBatchFile({ acct, deviceId: h['x-device'], index: h['x-batch'], key: needKey(h), text, deps }));
      }
      if (p === '/api/iot/raw-anchor') return sendJson(res, 200, await apiIotRawAnchor(h, req));
      if (p === '/api/tiers/outage') { ipfs.state.premiseDown = url.searchParams.get('on') === '1'; return sendJson(res, 200, { simulatedOutage: ipfs.state.premiseDown }); }
    }
    throw new ApiError(404, 'Not found.');
  } catch (e) {
    if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message });
    sendJson(res, 500, { error: 'Unexpected server error: ' + String(e.message || e).slice(0, 200) });
  }
});

(async () => {
  console.log('Evidence Vault server' + (DEMO ? ' (demo mode, stand in ledger)' : ''));
  const st = await apiStatus();
  console.log('  IPFS node :', st.ipfs.ok ? 'connected, Kubo ' + st.ipfs.version : 'NOT reachable at ' + ipfs.PREMISE + ' (run: ipfs daemon)');
  if (ipfs.CLOUD) console.log('  Cloud node:', st.tiers.cloud.ok ? 'connected, Kubo ' + st.tiers.cloud.version : 'NOT reachable at ' + ipfs.CLOUD);
  console.log('  Ledger    :', st.chain.ok ? chain.kind + ', channel ' + chain.channel + ', ' + st.accounts.length + ' identities' : 'NOT ready: ' + (st.error || 'unknown error'));
  if (!st.chain.ok && !DEMO) console.log('            Check that the Fabric network is up and that WSL is running.');
  server.listen(PORT, '127.0.0.1', () => console.log('Open http://localhost:' + PORT + ' in your browser. Press Ctrl+C to stop.'));
})();
