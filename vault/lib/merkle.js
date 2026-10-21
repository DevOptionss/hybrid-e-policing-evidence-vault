'use strict';
/**
 * Merkle tree over a list of SHA 256 hashes (segments or sensor readings).
 * Leaves bind the position: leaf = SHA256(0x00 || index as 8 bytes || hash).
 * Inner nodes use a different marker: node = SHA256(0x01 || left || right).
 * The tree splits at the largest power of two below the count, so no leaf is ever duplicated.
 */
const crypto = require('crypto');

const sha = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();

function leaf(index, hashHex) {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64BE(BigInt(index));
  return sha(Buffer.from([0]), idx, Buffer.from(hashHex, 'hex'));
}

function reduce(nodes, lo, hi) {
  const n = hi - lo;
  if (n === 1) return nodes[lo];
  let k = 1;
  while (k * 2 < n) k *= 2;
  return sha(Buffer.from([1]), reduce(nodes, lo, lo + k), reduce(nodes, lo + k, hi));
}

function rootOf(hashesHex) {
  if (!hashesHex.length) throw new Error('A Merkle tree needs at least one leaf');
  return reduce(hashesHex.map((h, i) => leaf(i, h)), 0, hashesHex.length).toString('hex');
}

module.exports = { rootOf, leaf };
