'use strict';

const { Contract } = require('fabric-contract-api');
const c = require('./common');

/**
 * Evidence registry. Roles: admin (grants roles, registers evidence), investigator (registers
 * evidence, hands custody on), verifier (read only). Anyone else is refused.
 * Version 1.1 adds event timestamps and a hash linked chain of custody for every record.
 */
class EvidenceContract extends Contract {
  // Helper methods start with an underscore, so Fabric does not expose them as transactions.
  async _roleOf(ctx, id) { return c.roleOf(ctx, id); }
  async _require(ctx, allowed) { return c.requireRole(ctx, allowed); }
  async _load(ctx, evidenceId) { return c.loadEvidence(ctx, evidenceId); }

  async _grant(ctx, id, role) {
    await c.requireRole(ctx, ['admin']);
    if (!id || typeof id !== 'string') throw new Error('An identity ID is required');
    if ((await c.roleOf(ctx, id)) === 'admin') throw new Error('The administrator role cannot be changed');
    await ctx.stub.putState(c.roleKey(id), Buffer.from(role));
    ctx.stub.setEvent('RoleGranted', Buffer.from(JSON.stringify({ id, role, time: c.timestampMs(ctx.stub.getTxTimestamp()) })));
    return JSON.stringify({ id, role });
  }

  /** Called once by the administrator. The caller becomes the administrator. */
  async InitLedger(ctx) {
    const existing = await ctx.stub.getState(c.ADMIN_KEY);
    if (existing && existing.length) throw new Error('Ledger already initialised');
    const id = ctx.clientIdentity.getID();
    await ctx.stub.putState(c.ADMIN_KEY, Buffer.from(id));
    await ctx.stub.putState(c.roleKey(id), Buffer.from('admin'));
    await ctx.stub.putState(c.COUNT_KEY, Buffer.from('0'));
    ctx.stub.setEvent('RoleGranted', Buffer.from(JSON.stringify({ id, role: 'admin', time: c.timestampMs(ctx.stub.getTxTimestamp()) })));
    return JSON.stringify({ initialised: true, admin: id });
  }

  /** Read only. Shows the caller's identity ID and role. */
  async WhoAmI(ctx) {
    const id = ctx.clientIdentity.getID();
    return JSON.stringify({ id, mspId: ctx.clientIdentity.getMSPID(), role: await c.roleOf(ctx, id) });
  }

  async AddInvestigator(ctx, id) { return this._grant(ctx, id, 'investigator'); }
  async AddVerifier(ctx, id) { return this._grant(ctx, id, 'verifier'); }

  async RegisterEvidence(ctx, caseId, cid, fileHash) {
    await c.requireRole(ctx, c.WRITE_ROLES);
    const record = await c.createEvidence(ctx, { caseId, cid, fileHash, eventName: 'EvidenceRegistered' });
    return JSON.stringify({ evidenceId: record.evidenceId });
  }

  async TransferCustody(ctx, evidenceId, toId) {
    await c.requireRole(ctx, c.WRITE_ROLES);
    const record = await c.loadEvidence(ctx, evidenceId);
    const caller = ctx.clientIdentity.getID();
    if (record.custodian !== caller) throw new Error('Not custodian');
    const toRole = await c.roleOf(ctx, toId);
    if (toRole !== 'admin' && toRole !== 'investigator') throw new Error('Recipient not authorised');

    const time = c.timestampMs(ctx.stub.getTxTimestamp());
    const txId = ctx.stub.getTxID();
    const n = record.custodyCount || 0;
    const prev = record.custodyHead || record.fileHash;
    const hash = c.custodyHash(prev, record.evidenceId, caller, toId, time, txId);
    const entry = { n, prev, from: caller, to: toId, time, txId, hash };

    record.custodian = toId;
    record.custodyHead = hash;
    record.custodyCount = n + 1;
    await ctx.stub.putState(c.evidenceKey(record.evidenceId), Buffer.from(JSON.stringify(record)));
    await ctx.stub.putState(c.custodyKey(record.evidenceId, n), Buffer.from(JSON.stringify(entry)));
    ctx.stub.setEvent('CustodyTransferred', Buffer.from(JSON.stringify({ evidenceId: record.evidenceId, from: caller, to: toId, time, custodyHash: hash })));
    return JSON.stringify({ evidenceId: record.evidenceId, custodian: toId });
  }

  async GetEvidence(ctx, evidenceId) {
    await c.requireRole(ctx, c.READ_ROLES);
    return JSON.stringify(await c.loadEvidence(ctx, evidenceId));
  }

  async GetAllEvidence(ctx) {
    await c.requireRole(ctx, c.READ_ROLES);
    return JSON.stringify(await c.readRange(ctx, 'EVID~', 'EVID~~'));
  }

  async GetEvidenceCount(ctx) {
    const bytes = await ctx.stub.getState(c.COUNT_KEY);
    return JSON.stringify({ count: parseInt(bytes && bytes.length ? c.text(bytes) : '0', 10) });
  }

  /** The chain of custody for one record, checked link by link inside the chaincode. */
  async GetCustodyTrail(ctx, evidenceId) {
    await c.requireRole(ctx, c.READ_ROLES);
    const record = await c.loadEvidence(ctx, evidenceId);
    const id = String(record.evidenceId).padStart(8, '0');
    const entries = await c.readRange(ctx, 'CUST~' + id + '~', 'CUST~' + id + '~~');
    let valid = true;
    let prev = record.fileHash;
    for (const e of entries) {
      const expected = c.custodyHash(e.prev, record.evidenceId, e.from, e.to, e.time, e.txId);
      if (e.prev !== prev || e.hash !== expected) valid = false;
      prev = e.hash;
    }
    if (entries.length && prev !== record.custodyHead) valid = false;
    if (!entries.length && record.custodyHead) valid = false;
    return JSON.stringify({ evidenceId: record.evidenceId, fileHash: record.fileHash, head: record.custodyHead || null, count: entries.length, valid, entries });
  }

  /** Every version this record has had on the ledger, oldest first. */
  async GetHistory(ctx, evidenceId) {
    await c.requireRole(ctx, c.READ_ROLES);
    const record = await c.loadEvidence(ctx, evidenceId);
    const out = [];
    const iterator = await ctx.stub.getHistoryForKey(c.evidenceKey(record.evidenceId));
    for (;;) {
      const res = await iterator.next();
      if (res.value) {
        const v = res.value;
        const raw = v.value && v.value.length ? c.text(v.value) : null;
        out.push({
          txId: v.txId || v.tx_id,
          timestamp: c.timestampMs(v.timestamp),
          isDelete: Boolean(v.isDelete !== undefined ? v.isDelete : v.is_delete),
          custodian: raw ? JSON.parse(raw).custodian : null,
        });
      }
      if (res.done) {
        await iterator.close();
        break;
      }
    }
    return JSON.stringify(out);
  }
}

module.exports = EvidenceContract;
