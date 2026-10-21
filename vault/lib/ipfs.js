'use strict';
/**
 * Two storage tiers. The on premise node holds everything. When CLOUD_IPFS_API is set, a second node
 * receives a replica of the same encrypted bytes, and reads fall back to it if the first cannot answer.
 *
 * Uploads are sent as hand built multipart bodies. For large files a single "part" buffer is reused for every
 * segment, so no new copy of the data is made each time.
 */
const { ApiError } = require('./errors');

const PREMISE = process.env.IPFS_API || 'http://127.0.0.1:5001/api/v0';
const CLOUD = process.env.CLOUD_IPFS_API || '';
const state = { premiseDown: false };     // a switch for demonstrating an on premise outage

const BOUNDARY = '----vaultboundary7f3a9c41';
const HEAD = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="data"\r\nContent-Type: application/octet-stream\r\n\r\n`);
const TAIL = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
const HEADERS = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` };

async function post(api, pathAndQuery, options) {
  try {
    return await fetch(api + pathAndQuery, { method: 'POST', ...options });
  } catch (e) {
    throw new ApiError(503, 'The IPFS node is not reachable at ' + api + '. Start it with: ipfs daemon');
  }
}

async function send(api, body, onlyHash) {
  const r = await post(api, '/add' + (onlyHash ? '?only-hash=true' : ''), { headers: HEADERS, body });
  if (!r.ok) throw new ApiError(502, 'IPFS refused the upload: ' + (await r.text()).slice(0, 160));
  return (await r.json()).Hash;
}

/** A reusable buffer that already holds the multipart header. Write the data into part.data(len). */
function makePart(maxBytes) {
  const body = Buffer.allocUnsafe(HEAD.length + maxBytes + TAIL.length);
  HEAD.copy(body, 0);
  return { body, max: maxBytes, data: (len) => body.subarray(HEAD.length, HEAD.length + len) };
}
function sealed(part, len) {
  TAIL.copy(part.body, HEAD.length + len);
  return part.body.subarray(0, HEAD.length + len + TAIL.length);
}

async function addTo(api, buf, onlyHash) {
  return send(api, Buffer.concat([HEAD, buf, TAIL]), onlyHash);
}

/** Stores the bytes on the on premise node and, if configured, on the cloud node. */
async function addBody(body) {
  let t = performance.now();
  const cid = await send(PREMISE, body, false);
  const premiseMs = performance.now() - t;
  let cloudMs = 0;
  if (CLOUD) {
    t = performance.now();
    const replica = await send(CLOUD, body, false);
    if (replica !== cid) throw new ApiError(502, 'The cloud node returned a different content ID than the on premise node.');
    cloudMs = performance.now() - t;
  }
  return { cid, premiseMs, cloudMs };
}
const add = (buf) => addBody(Buffer.concat([HEAD, buf, TAIL]));
const addPart = (part, len) => addBody(sealed(part, len));

/** Computes the content ID without storing anything. */
const hashOnly = (buf) => addTo(PREMISE, buf, true);
const hashPart = (part, len) => send(PREMISE, sealed(part, len), true);

async function catFrom(api, cid) {
  try {
    const r = await fetch(api + '/cat?timeout=10s&arg=' + encodeURIComponent(cid), { method: 'POST' });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch (e) {
    return null;
  }
}

/** Reads from the on premise node first, then from the cloud node. */
async function cat(cid) {
  if (!state.premiseDown) {
    const data = await catFrom(PREMISE, cid);
    if (data) return { data, tier: 'premise' };
  }
  if (CLOUD) {
    const data = await catFrom(CLOUD, cid);
    if (data) return { data, tier: 'cloud' };
  }
  return null;
}

async function version(api) {
  try {
    const r = await fetch(api + '/version', { method: 'POST', signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).Version : null;
  } catch (e) {
    return null;
  }
}

async function tiers() {
  const premise = await version(PREMISE);
  const cloud = CLOUD ? await version(CLOUD) : null;
  return {
    premise: { ok: Boolean(premise), version: premise, simulatedOutage: state.premiseDown },
    cloud: { enabled: Boolean(CLOUD), ok: Boolean(cloud), version: cloud },
  };
}

module.exports = { add, addPart, hashOnly, hashPart, makePart, cat, tiers, state, PREMISE, CLOUD };
