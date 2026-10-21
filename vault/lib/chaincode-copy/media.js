'use strict';

const { Contract } = require('fabric-contract-api');
const c = require('./common');

const TYPES = ['multimedia', 'cctv'];
const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const batchKey = (device, n) => 'BATCH~' + device + '~' + String(n).padStart(8, '0');
const deviceKey = (device) => 'DEV~' + device;
const headKey = (device) => 'BATCHHEAD~' + device;
const mediaKey = (id) => 'MEDIA~' + String(id).padStart(8, '0');

function int(value, name, min, max) {
  if (!/^\d+$/.test(String(value))) throw new Error(name + ' must be a whole number');
  const n = Number(value);
  if (n < min || n > max) throw new Error(name + ' must be between ' + min + ' and ' + max);
  return n;
}

/**
 * Objective 4 functions: manifests for multimedia and CCTV evidence, and a sequenced batch
 * anchor for IoT sensor data. It lives in the same chaincode as EvidenceContract, so it shares
 * the same roles and the same chain of custody. Call it as "MediaContract:FunctionName".
 */
class MediaContract extends Contract {
  /** Administrator binds a device to the gateway identity allowed to anchor its batches. */
  async RegisterDevice(ctx, deviceId, gatewayId) {
    await c.requireRole(ctx, ['admin']);
    if (!DEVICE_ID.test(deviceId || '')) throw new Error('The device ID must be 1 to 64 letters, digits, dots, dashes or underscores');
    if (!gatewayId) throw new Error('A gateway identity ID is required');
    const existing = await ctx.stub.getState(deviceKey(deviceId));
    if (existing && existing.length) throw new Error('Device already registered');
    const time = c.timestampMs(ctx.stub.getTxTimestamp());
    await ctx.stub.putState(deviceKey(deviceId), Buffer.from(JSON.stringify({ deviceId, gateway: gatewayId, registeredBy: ctx.clientIdentity.getID(), time })));
    await ctx.stub.putState(headKey(deviceId), Buffer.from(JSON.stringify({ count: 0, lastHash: c.ZERO64 })));
    ctx.stub.setEvent('DeviceRegistered', Buffer.from(JSON.stringify({ deviceId, gateway: gatewayId, time })));
    return JSON.stringify({ deviceId });
  }

  /**
   * Registers a recording or media file. The manifest is stored in IPFS, and its content ID goes
   * on the ledger together with the Merkle root over the segments and the hash of the whole file.
   * The item gets an ordinary evidence record, so custody transfers and the custody trail work as usual.
   */
  async RegisterManifest(ctx, caseId, evidenceType, manifestCid, merkleRoot, originalHash, segmentCount, captureStart, captureEnd) {
    await c.requireRole(ctx, c.WRITE_ROLES);
    if (!TYPES.includes(evidenceType)) throw new Error('The evidence type must be one of: ' + TYPES.join(', '));
    if (!c.HEX64.test(merkleRoot || '')) throw new Error('The Merkle root must be 64 lowercase hex characters');
    const segments = int(segmentCount, 'The segment count', 1, 1000000);
    const start = int(captureStart, 'The capture start', 0, Number.MAX_SAFE_INTEGER);
    const end = int(captureEnd, 'The capture end', 0, Number.MAX_SAFE_INTEGER);
    if (end < start) throw new Error('The capture end must not be before the capture start');

    const record = await c.createEvidence(ctx, {
      caseId, cid: manifestCid, fileHash: originalHash,
      eventName: 'ManifestRegistered', eventExtra: { evidenceType, merkleRoot, segmentCount: segments },
    });
    const media = { evidenceId: record.evidenceId, evidenceType, merkleRoot, segmentCount: segments, captureStart: start, captureEnd: end };
    await ctx.stub.putState(mediaKey(record.evidenceId), Buffer.from(JSON.stringify(media)));
    return JSON.stringify({ evidenceId: record.evidenceId });
  }

  async GetManifest(ctx, evidenceId) {
    await c.requireRole(ctx, c.READ_ROLES);
    const evidence = await c.loadEvidence(ctx, evidenceId);
    const bytes = await ctx.stub.getState(mediaKey(evidence.evidenceId));
    if (!bytes || !bytes.length) throw new Error('Not a manifest record');
    return JSON.stringify({ evidence, media: JSON.parse(c.text(bytes)) });
  }

  /** Anchors the next batch of readings for a device. Only the bound gateway may call it, in strict sequence. */
  async AnchorBatch(ctx, deviceId, batchIndex, merkleRoot, readingCount, cid) {
    const devBytes = await ctx.stub.getState(deviceKey(deviceId || ''));
    if (!devBytes || !devBytes.length) throw new Error('No such device');
    const device = JSON.parse(c.text(devBytes));
    if (ctx.clientIdentity.getID() !== device.gateway) throw new Error('Not authorised');

    const index = int(batchIndex, 'The batch index', 1, Number.MAX_SAFE_INTEGER);
    if (!c.HEX64.test(merkleRoot || '')) throw new Error('The Merkle root must be 64 lowercase hex characters');
    const readings = int(readingCount, 'The reading count', 1, 100000);
    if (!cid || cid.length > 120) throw new Error('A content ID of up to 120 characters is required');

    const head = JSON.parse(c.text(await ctx.stub.getState(headKey(deviceId))));
    if (index <= head.count) throw new Error('Batch already anchored');
    if (index !== head.count + 1) throw new Error('Batch index out of sequence, expected ' + (head.count + 1));

    const batchHash = c.sha256hex(JSON.stringify([head.lastHash, merkleRoot, index, deviceId]));
    const time = c.timestampMs(ctx.stub.getTxTimestamp());
    const batch = { deviceId, batchIndex: index, merkleRoot, batchHash, prevHash: head.lastHash, readingCount: readings, cid, time, txId: ctx.stub.getTxID() };
    await ctx.stub.putState(batchKey(deviceId, index), Buffer.from(JSON.stringify(batch)));
    await ctx.stub.putState(headKey(deviceId), Buffer.from(JSON.stringify({ count: index, lastHash: batchHash })));
    ctx.stub.setEvent('BatchAnchored', Buffer.from(JSON.stringify({ deviceId, batchIndex: index, merkleRoot, batchHash, readingCount: readings, cid, time })));
    return JSON.stringify({ batchIndex: index, batchHash });
  }

  async GetBatch(ctx, deviceId, batchIndex) {
    await c.requireRole(ctx, c.READ_ROLES);
    const bytes = await ctx.stub.getState(batchKey(deviceId, int(batchIndex, 'The batch index', 1, Number.MAX_SAFE_INTEGER)));
    if (!bytes || !bytes.length) throw new Error('No such batch');
    return c.text(bytes);
  }

  /** Public. The head of a device's batch sequence, so anyone can check it against a stored copy. */
  async LastBatch(ctx, deviceId) {
    const bytes = await ctx.stub.getState(headKey(deviceId || ''));
    if (!bytes || !bytes.length) throw new Error('No such device');
    return c.text(bytes);
  }

  async GetBatchChain(ctx, deviceId) {
    await c.requireRole(ctx, c.READ_ROLES);
    if (!DEVICE_ID.test(deviceId || '')) throw new Error('No such device');
    return JSON.stringify(await c.readRange(ctx, 'BATCH~' + deviceId + '~', 'BATCH~' + deviceId + '~~'));
  }
}

module.exports = MediaContract;
