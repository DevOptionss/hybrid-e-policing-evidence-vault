'use strict';
/**
 * Objective 4: multimedia and CCTV evidence.
 * A file is cut into fixed size byte segments of the untouched original. Each segment is hashed,
 * encrypted with its own chaos map keystream and stored in IPFS. A Merkle tree over the segment hashes
 * gives one root, which goes on the ledger with the content ID of an encrypted manifest.
 */
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { crypt } = require('./chaos');
const merkle = require('./merkle');
const ipfs = require('./ipfs');
const { ApiError } = require('./errors');
const { maybeGc } = require('./gc');

const DEFAULT_SEGMENT = 4 * 1024 * 1024;
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
const r1 = (x) => Math.round(x * 10) / 10;

/* ----------------------------------------------------------------- time index */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 120000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Reads the duration and the byte position of each video packet with ffprobe, if it is installed. */
async function probe(filePath) {
  const fmt = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath]);
  const duration = fmt ? parseFloat(fmt) : NaN;
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,pos', '-of', 'csv=p=0', filePath]);
  const packets = [];
  if (out) {
    for (const line of out.split('\n')) {
      const [t, pos] = line.split(',');
      const tt = parseFloat(t), pp = parseInt(pos, 10);
      if (Number.isFinite(tt) && Number.isFinite(pp)) packets.push({ t: tt, pos: pp });
    }
  }
  return { duration: Number.isFinite(duration) ? duration : null, packets };
}

/** A time window for every segment, in milliseconds. Uses packet positions when ffprobe supplied them. */
function timeWindows(info, size, segSize, captureStart, captureEnd) {
  const count = Math.ceil(size / segSize);
  const windows = [];
  if (info && info.packets.length) {
    const packets = info.packets.slice().sort((a, b) => a.pos - b.pos);
    let p = 0, last = 0;
    for (let i = 0; i < count; i++) {
      const start = i * segSize, end = Math.min(size, start + segSize);
      let lo = Infinity, hi = -Infinity;
      while (p < packets.length && packets[p].pos < end) {
        if (packets[p].pos >= start) { lo = Math.min(lo, packets[p].t); hi = Math.max(hi, packets[p].t); }
        p++;
      }
      if (lo === Infinity) { lo = last; hi = last; }
      last = hi;
      windows.push({ t0: captureStart + Math.round(lo * 1000), t1: captureStart + Math.round(hi * 1000) });
    }
    return { source: 'ffprobe', windows };
  }
  const span = Math.max(0, captureEnd - captureStart);
  for (let i = 0; i < count; i++) {
    const start = i * segSize, end = Math.min(size, start + segSize);
    windows.push({ t0: captureStart + Math.round(span * start / size), t1: captureStart + Math.round(span * end / size) });
  }
  return { source: 'proportional', windows };
}

/* ------------------------------------------------------------------ ingestion */
async function ingestFile({ acct, filePath, caseId, evidenceType, key, segmentSize, captureStart, captureEnd, fileName, mime, deps }) {
  const seg = segmentSize || DEFAULT_SEGMENT;
  if (!['cctv', 'multimedia'].includes(evidenceType)) throw new ApiError(400, 'The evidence type must be cctv or multimedia.');
  let st;
  try { st = await fs.promises.stat(filePath); } catch (e) { throw new ApiError(400, 'The file was not found: ' + filePath); }
  if (!st.isFile() || st.size === 0) throw new ApiError(400, 'The file is empty or is not a regular file.');

  // Ask the chaincode first, so an unauthorised identity is refused before any heavy work.
  await deps.evaluate(acct, 'MediaContract:RegisterManifest', caseId, evidenceType, 'preflight', 'a'.repeat(64), 'a'.repeat(64), '1', '0', '0');

  const T = { hash: 0, encrypt: 0, ipfs: 0, replicate: 0, probe: 0, manifest: 0, ledger: 0 };
  const started = performance.now();
  const whole = crypto.createHash('sha256');
  const segs = [];
  const buf = Buffer.allocUnsafe(Math.min(seg, st.size));
  const part = ipfs.makePart(Math.min(seg, st.size));       // reused for every encrypted segment
  const fh = await fs.promises.open(filePath, 'r');
  try {
    for (let pos = 0, i = 0; pos < st.size; pos += seg, i++) {
      const len = Math.min(seg, st.size - pos);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead !== len) throw new ApiError(500, 'The file could not be read completely.');
      const chunk = buf.subarray(0, len);

      let t = performance.now();
      const hash = sha256hex(chunk);
      whole.update(chunk);
      T.hash += performance.now() - t;

      t = performance.now();
      crypt(key, i, chunk, part.data(len));
      T.encrypt += performance.now() - t;

      const stored = await ipfs.addPart(part, len);
      T.ipfs += stored.premiseMs;
      T.replicate += stored.cloudMs;
      segs.push({ i, start: pos, end: pos + len, hash, cid: stored.cid });
      maybeGc(i);
    }
  } finally {
    await fh.close();
  }

  const originalHash = whole.digest('hex');
  const root = merkle.rootOf(segs.map((s) => s.hash));

  let t = performance.now();
  const info = await probe(filePath);
  T.probe = performance.now() - t;
  const cs = Number.isFinite(captureStart) ? captureStart : Math.round(st.mtimeMs);
  const ce = Number.isFinite(captureEnd) ? captureEnd : (info.duration ? cs + Math.round(info.duration * 1000) : cs);
  const tw = timeWindows(info, st.size, seg, cs, ce);

  const manifest = {
    version: 1, evidenceType, caseId, fileName: fileName || filePath.split(/[\\/]/).pop(), fileSize: st.size,
    mime: mime || 'application/octet-stream', originalHash, segmentSize: seg, segmentCount: segs.length,
    captureStart: cs, captureEnd: ce, timeIndex: tw.source,
    segments: segs.map((s, i) => ({ ...s, t0: tw.windows[i].t0, t1: tw.windows[i].t1 })),
  };
  t = performance.now();
  const encManifest = crypt(key, 'manifest', Buffer.from(JSON.stringify(manifest)));
  const stored = await ipfs.add(encManifest);
  T.manifest = performance.now() - t;

  t = performance.now();
  const tx = await deps.submit(acct, 'MediaContract:RegisterManifest', caseId, evidenceType, stored.cid, root, originalHash, String(segs.length), String(cs), String(ce));
  T.ledger = performance.now() - t;

  deps.saveMeta(tx.result.evidenceId, stored.cid, { fileName: manifest.fileName, fileSize: st.size, mime: manifest.mime, kind: evidenceType });
  const timings = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, r1(v)]));
  timings.total = r1(performance.now() - started);
  return {
    evidenceId: tx.result.evidenceId, evidenceType, fileSize: st.size, segmentSize: seg, segmentCount: segs.length,
    merkleRoot: root, originalHash, manifestCid: stored.cid, manifestBytes: encManifest.length, timeIndex: tw.source,
    txId: tx.txId, blockNumber: tx.blockNumber, timings,
  };
}

/* ------------------------------------------------------------------ manifests */
async function loadManifest(cid, key) {
  const got = await ipfs.cat(cid);
  if (!got) return { found: false };
  const cidNow = await ipfs.hashOnly(got.data);
  let manifest = null;
  try { manifest = JSON.parse(crypt(key, 'manifest', got.data).toString('utf8')); } catch (e) { /* wrong key or damaged */ }
  return { found: true, cidOk: cidNow === cid, decrypted: Boolean(manifest && Array.isArray(manifest.segments)), manifest, tier: got.tier };
}

async function ledgerView(acct, evidenceId, deps) {
  const m = await deps.evaluate(acct, 'MediaContract:GetManifest', String(evidenceId));
  return { evidence: m.evidence, media: m.media };
}

function describeManifest(lm) {
  if (!lm.found) return 'The manifest could not be retrieved from any storage tier.';
  if (!lm.cidOk) return 'The manifest bytes no longer match the content ID on the ledger.';
  if (!lm.decrypted) return 'The manifest could not be decrypted. The session key may be wrong.';
  return null;
}

/* ---------------------------------------------------------- comparing segments */
function diffSegments(oldH, newH) {
  const n = oldH.length, m = newH.length;
  if (n === m && oldH.every((h, i) => newH[i] === h)) return { kind: 'identical', changed: [], missing: [], extra: [] };
  const sameUpTo = (limit) => { let k = 0; while (k < limit && newH[k] === oldH[k]) k++; return k; };
  if (n === m) {
    const changed = range(0, n).filter((i) => oldH[i] !== newH[i]);
    const swapped = changed.length === 2 && newH[changed[0]] === oldH[changed[1]] && newH[changed[1]] === oldH[changed[0]];
    return { kind: swapped ? 'reordered' : 'altered', changed, missing: [], extra: [] };
  }
  if (m < n) {
    const k = sameUpTo(m);
    if (k === m) return { kind: 'truncated', changed: [], missing: range(m, n), extra: [] };
    const d = n - m;
    let removed = true;
    for (let j = k; j < m; j++) if (newH[j] !== oldH[j + d]) { removed = false; break; }
    if (removed) return { kind: 'deleted', at: k, count: d, changed: [], missing: range(k, k + d), extra: [] };
    return { kind: 'altered', changed: range(k, m).filter((i) => newH[i] !== oldH[i]), missing: range(m, n), extra: [] };
  }
  const k = sameUpTo(n);
  if (k === n) return { kind: 'extended', changed: [], missing: [], extra: range(n, m) };
  const d = m - n;
  let inserted = true;
  for (let j = k; j < n; j++) if (newH[j + d] !== oldH[j]) { inserted = false; break; }
  if (inserted) return { kind: 'inserted', at: k, count: d, changed: [], missing: [], extra: range(k, k + d) };
  return { kind: 'altered', changed: range(k, n).filter((i) => newH[i] !== oldH[i]), missing: [], extra: range(n, m) };
}

function locate(manifest, indexes) {
  return indexes.map((i) => {
    const s = manifest.segments[i];
    return s ? { i, byteStart: s.start, byteEnd: s.end, t0: s.t0, t1: s.t1 } : { i };
  });
}

/* --------------------------------------------------- verifying the vault copy */
async function verifyVault({ acct, evidenceId, key, deps }) {
  const started = performance.now();
  const { evidence, media } = await ledgerView(acct, evidenceId, deps);
  const out = {
    evidenceId: evidence.evidenceId, evidenceType: media.evidenceType, ok: false,
    ledger: { merkleRoot: media.merkleRoot, segmentCount: media.segmentCount, originalHash: evidence.fileHash },
    manifest: {}, root: {}, count: {}, segments: { checked: 0, bad: [] }, wholeFile: { ok: null }, tiers: { premise: 0, cloud: 0 }, reason: null,
  };
  const lm = await loadManifest(evidence.cid, key);
  out.manifest = { found: lm.found, cidOk: lm.cidOk || false, decrypted: lm.decrypted || false, tier: lm.tier || null };
  out.reason = describeManifest(lm);
  if (out.reason) return finish(out, started);
  if (lm.tier) out.tiers[lm.tier]++;

  const manifest = lm.manifest;
  const computed = merkle.rootOf(manifest.segments.map((s) => s.hash));
  out.root = { ok: computed === media.merkleRoot, ledger: media.merkleRoot, computed };
  out.count = { ok: manifest.segments.length === media.segmentCount, ledger: media.segmentCount, manifest: manifest.segments.length };
  out.manifest.hashOk = manifest.originalHash === evidence.fileHash;
  if (!out.root.ok || !out.count.ok || !out.manifest.hashOk) {
    out.reason = !out.root.ok ? 'The manifest has been altered: its segment hashes no longer produce the Merkle root on the ledger.'
      : !out.count.ok ? 'The manifest lists a different number of segments than the ledger.' : 'The manifest records a different file hash than the ledger.';
    return finish(out, started);
  }

  const whole = crypto.createHash('sha256');
  const part = ipfs.makePart(manifest.segmentSize);
  const plainBuf = Buffer.allocUnsafe(manifest.segmentSize);
  for (const s of manifest.segments) {
    out.segments.checked++;
    const got = await ipfs.cat(s.cid);
    if (!got) { out.segments.bad.push({ i: s.i, reason: 'missing', ...locate(manifest, [s.i])[0] }); continue; }
    out.tiers[got.tier]++;
    let cidNow = null;
    if (got.data.length <= part.max) {
      got.data.copy(part.data(got.data.length));
      cidNow = await ipfs.hashPart(part, got.data.length);
    } else {
      cidNow = await ipfs.hashOnly(got.data);
    }
    const plain = got.data.length <= plainBuf.length ? crypt(key, s.i, got.data, plainBuf) : crypt(key, s.i, got.data);
    maybeGc(s.i);
    whole.update(plain);
    if (cidNow !== s.cid) out.segments.bad.push({ i: s.i, reason: 'content ID mismatch', ...locate(manifest, [s.i])[0] });
    else if (sha256hex(plain) !== s.hash) out.segments.bad.push({ i: s.i, reason: 'hash mismatch', ...locate(manifest, [s.i])[0] });
  }
  if (!out.segments.bad.length) out.wholeFile.ok = whole.digest('hex') === evidence.fileHash;
  out.ok = out.segments.bad.length === 0 && out.wholeFile.ok === true;
  if (!out.ok && !out.reason) out.reason = out.segments.bad.length ? out.segments.bad.length + ' segment(s) no longer match the manifest.' : 'The reassembled file does not match the hash on the ledger.';
  return finish(out, started);
}
function finish(out, started) { out.ms = r1(performance.now() - started); return out; }

/* ---------------------------------------------------- checking a file you hold */
async function checkFile({ acct, evidenceId, key, filePath, deps }) {
  const started = performance.now();
  const { evidence, media } = await ledgerView(acct, evidenceId, deps);
  const lm = await loadManifest(evidence.cid, key);
  const problem = describeManifest(lm);
  if (problem) throw new ApiError(409, problem);
  const manifest = lm.manifest;
  const oldH = manifest.segments.map((s) => s.hash);
  if (merkle.rootOf(oldH) !== media.merkleRoot) throw new ApiError(409, 'The manifest has been altered, so the file cannot be compared against it.');

  const seg = manifest.segmentSize;
  const st = await fs.promises.stat(filePath);
  const whole = crypto.createHash('sha256');
  const newH = [];
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(seg);
    for (let pos = 0; pos < st.size; pos += seg) {
      const len = Math.min(seg, st.size - pos);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      const chunk = buf.subarray(0, bytesRead);
      whole.update(chunk);
      newH.push(sha256hex(chunk));
    }
  } finally {
    await fh.close();
  }
  const d = diffSegments(oldH, newH);
  const rootNew = newH.length ? merkle.rootOf(newH) : null;
  const hashNew = whole.digest('hex');
  return {
    evidenceId: evidence.evidenceId, fileSize: st.size, expectedSize: manifest.fileSize,
    segments: { expected: oldH.length, found: newH.length },
    rootMatch: rootNew === media.merkleRoot, hashMatch: hashNew === evidence.fileHash,
    ledger: { merkleRoot: media.merkleRoot, originalHash: evidence.fileHash }, computed: { merkleRoot: rootNew, originalHash: hashNew },
    diff: d, located: locate(manifest, [...d.changed, ...d.missing]), extra: d.extra, timeIndex: manifest.timeIndex,
    ok: rootNew === media.merkleRoot && hashNew === evidence.fileHash, ms: r1(performance.now() - started),
  };
}

/* ----------------------------------------------- an insider who doctors the manifest */
async function attackManifestEdit({ evidenceId, key, deps }) {
  const { evidence, media } = await ledgerView('officerA', evidenceId, deps);
  const lm = await loadManifest(evidence.cid, key);
  const problem = describeManifest(lm);
  if (problem) throw new ApiError(409, problem);
  const doctored = JSON.parse(JSON.stringify(lm.manifest));
  const i = Math.floor(doctored.segments.length / 2);
  const h = doctored.segments[i].hash;
  doctored.segments[i].hash = (h[0] === 'a' ? 'b' : 'a') + h.slice(1);
  const stored = await ipfs.add(crypt(key, 'manifest', Buffer.from(JSON.stringify(doctored))));
  const tx = await deps.submit('officerA', 'MediaContract:RegisterManifest', evidence.caseId + ' (doctored manifest)', media.evidenceType, stored.cid,
    media.merkleRoot, evidence.fileHash, String(media.segmentCount), String(media.captureStart), String(media.captureEnd));
  deps.saveMeta(tx.result.evidenceId, stored.cid, { fileName: (lm.manifest.fileName || 'media') + ' (doctored manifest)', fileSize: lm.manifest.fileSize, mime: lm.manifest.mime, kind: media.evidenceType });
  return {
    select: tx.result.evidenceId, data: { segmentIndex: i, newEvidenceId: tx.result.evidenceId },
    lines: [
      'The hash of segment ' + i + ' inside the manifest of evidence ' + evidenceId + ' was edited and the doctored manifest was added to IPFS.',
      'A new record, evidence ' + tx.result.evidenceId + ', now points at the doctored manifest but carries the original Merkle root and file hash.',
      'Run Verify on evidence ' + tx.result.evidenceId + ' to see the manifest edit caught.',
    ],
  };
}

module.exports = { ingestFile, verifyVault, checkFile, attackManifestEdit, diffSegments, probe, timeWindows, DEFAULT_SEGMENT };
