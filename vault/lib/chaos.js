'use strict';
/**
 * Chaos map keystream ciphers (XOR, so one call encrypts and decrypts).
 *
 * "basic":     the plain logistic map x -> 3.99 x (1 - x), seeded from 52 bits derived with SHA 256.
 *              Evaluation showed that in double precision every seed falls onto one cycle of 6,623,920 states,
 *              so the real key space is about 2^23 and long segments share keystream.
 * "perturbed": the same map, but every 8 steps the state is nudged by a small amount taken from SHA 256 of the
 *              key material and a counter. The key then has 256 bits, the orbit cannot settle on the cycle,
 *              and every segment gets an independent keystream. This is the default.
 *
 * Choose with CHAOS_MODE=basic or CHAOS_MODE=perturbed.
 */
const crypto = require('crypto');

const R = 3.99;
const FIXED_POINT = 1 - 1 / R;
const MODE = (process.env.CHAOS_MODE || 'perturbed').toLowerCase();
const STEP_BLOCK = 8;          // map steps between perturbations
const PERTURB_SCALE = 1e-6;    // size of each nudge

/* --------------------------------------------------------------------- basic */
function chaosCrypt(data, x0, outBuffer) {
  let x = x0;
  for (let i = 0; i < 1000; i++) x = R * x * (1 - x);
  const out = outBuffer ? outBuffer.subarray(0, data.length) : Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    x = R * x * (1 - x);
    out[i] = data[i] ^ (Math.floor(x * 1e14) % 256);
  }
  return out;
}

/** An independent seed for a label, from the first 52 bits of SHA 256(master:label:attempt). */
function seedFor(master, label) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const digest = crypto.createHash('sha256').update(`${master}:${label}:${attempt}`).digest();
    const x = Number(digest.readBigUInt64BE(0) >> 12n) / 4503599627370496;
    const usable = x > 1e-6 && x < 1 - 1e-6 && Math.abs(x - 0.5) > 1e-6 && Math.abs(x - FIXED_POINT) > 1e-6;
    if (usable) return x;
  }
  throw new Error('Could not derive a usable chaos map seed');
}

/* ----------------------------------------------------------------- perturbed */
const material = (master, label) => crypto.createHash('sha256').update(`${master}:${label}:material`).digest();

function perturbedCrypt(data, key, outBuffer) {
  let x = Number(key.readBigUInt64BE(0) >> 12n) / 4503599627370496;
  if (!(x > 0.01 && x < 0.99)) x = 0.3141592653589793;
  for (let i = 0; i < 1000; i++) x = R * x * (1 - x);
  const out = outBuffer ? outBuffer.subarray(0, data.length) : Buffer.allocUnsafe(data.length);
  const counterBuf = Buffer.alloc(40);
  key.copy(counterBuf, 0);
  let counter = 0n, pool = null, poolPos = 32;
  for (let i = 0; i < data.length; i++) {
    if (i % STEP_BLOCK === 0) {
      if (poolPos >= 32) {
        counterBuf.writeBigUInt64BE(counter++, 32);
        pool = crypto.createHash('sha256').update(counterBuf).digest();
        poolPos = 0;
      }
      x += (pool.readUInt32BE(poolPos) / 4294967296 - 0.5) * PERTURB_SCALE;
      poolPos += 4;
      if (!(x > 1e-9 && x < 1 - 1e-9)) x = 0.3141592653589793;
    }
    x = R * x * (1 - x);
    out[i] = data[i] ^ (Math.floor(x * 1e14) % 256);
  }
  return out;
}

/* ------------------------------------------------------------------ dispatch */
/** Encrypts or decrypts with a keystream for (master secret, label), using the selected mode. */
function crypt(master, label, data, outBuffer) {
  if (MODE === 'basic') return chaosCrypt(data, seedFor(master, label), outBuffer);
  return perturbedCrypt(data, material(master, label), outBuffer);
}

module.exports = { crypt, chaosCrypt, seedFor, perturbedCrypt, material, MODE };
