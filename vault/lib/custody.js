'use strict';
/**
 * Independent check of a chain of custody. It recomputes every link with SHA 256 and does not rely on the
 * chaincode's own "valid" flag, so anyone holding an exported trail can repeat it.
 *   link = SHA256( JSON [ previous link, evidence number, from, to, time, transaction ID ] )
 * The first link is chained to the SHA 256 hash of the evidence file.
 */
const crypto = require('crypto');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const entryHash = (prev, evidenceId, from, to, time, txId) => sha(JSON.stringify([prev, evidenceId, from, to, time, txId]));

function verifyTrail(trail) {
  const reasons = [];
  const entries = trail.entries || [];
  if (!trail.head && !entries.length) return { valid: null, checked: 0, reasons: ['This record has no custody chain (it was registered before version 1.1).'] };
  if (!entries.length) return { valid: false, checked: 0, reasons: ['The custody entries are missing.'] };
  let prev = trail.fileHash;
  entries.forEach((e, i) => {
    if (e.n !== i) reasons.push('Entry ' + i + ' has the wrong position number (' + e.n + ').');
    if (e.prev !== prev) reasons.push('Entry ' + i + ' does not follow the previous entry.');
    if (e.hash !== entryHash(e.prev, trail.evidenceId, e.from, e.to, e.time, e.txId)) reasons.push('Entry ' + i + ' does not match its own hash.');
    if (i > 0 && e.from !== entries[i - 1].to) reasons.push('Entry ' + i + ' hands over from someone who did not hold custody.');
    if (i > 0 && e.time < entries[i - 1].time) reasons.push('Entry ' + i + ' is dated before the entry before it.');
    prev = e.hash;
  });
  if (prev !== trail.head) reasons.push('The last entry does not match the head recorded with the evidence.');
  if (trail.count !== undefined && trail.count !== entries.length) reasons.push('The entry count does not match.');
  return { valid: reasons.length === 0, checked: entries.length, reasons };
}

module.exports = { verifyTrail, entryHash };
