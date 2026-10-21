'use strict';
/**
 * Evaluation of the chaos map cipher (Objective 5). It runs offline and needs no server.
 *   node tests/cipher-evaluation.js | Tee-Object evidence\cipher_evaluation.txt
 * It compares the original "basic" cipher with the "perturbed" cipher that is now the default.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chaosCrypt, seedFor, perturbedCrypt, material } = require('../lib/chaos');

const MiB = 1048576;
const R = 3.99;
const MODES = {
  basic: { keystream: (master, label, n) => chaosCrypt(Buffer.alloc(n), seedFor(master, label)), crypt: (m, l, d) => chaosCrypt(d, seedFor(m, l)) },
  perturbed: { keystream: (master, label, n) => perturbedCrypt(Buffer.alloc(n), material(master, label)), crypt: (m, l, d) => perturbedCrypt(d, material(m, l)) },
};

/* ------------------------------------------------------------ statistics */
function erfc(x) {                       // Numerical Recipes, fractional error below 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015; for (const k of c) s += k / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}
function gammaQ(a, x) {                  // upper regularised incomplete gamma
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break; }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
const popcount = (b) => { let c = 0; for (let i = 0; i < b.length; i++) { let v = b[i]; v -= (v >> 1) & 0x55; v = (v & 0x33) + ((v >> 2) & 0x33); c += (v + (v >> 4)) & 0x0f; } return c; };
const bitDiff = (a, b) => { let c = 0; for (let i = 0; i < a.length; i++) { let v = a[i] ^ b[i]; v -= (v >> 1) & 0x55; v = (v & 0x33) + ((v >> 2) & 0x33); c += (v + (v >> 4)) & 0x0f; } return c; };

function randomness(ks) {
  const n = ks.length, bits = n * 8;
  const counts = new Array(256).fill(0); for (const v of ks) counts[v]++;
  const exp = n / 256; let chi = 0, ent = 0;
  for (const c of counts) { chi += (c - exp) ** 2 / exp; if (c) ent -= (c / n) * Math.log2(c / n); }
  const ones = popcount(ks);
  const monobit = erfc(Math.abs(2 * ones - bits) / Math.sqrt(bits) / Math.SQRT2);
  const pi = ones / bits; let runs = 1, prev = ks[0] >> 7;
  for (let i = 0; i < n; i++) for (let k = 7; k >= 0; k--) { const b = (ks[i] >> k) & 1; if (i === 0 && k === 7) continue; if (b !== prev) runs++; prev = b; }
  const runsP = Math.abs(pi - 0.5) >= 2 / Math.sqrt(bits) ? 0 : erfc(Math.abs(runs - 2 * bits * pi * (1 - pi)) / (2 * Math.sqrt(2 * bits) * pi * (1 - pi)));
  let sx = 0, sxx = 0, sxy = 0; for (let i = 0; i < n - 1; i++) { sx += ks[i]; sxx += ks[i] * ks[i]; sxy += ks[i] * ks[i + 1]; }
  const m = n - 1, corr = (m * sxy - sx * sx) / (m * sxx - sx * sx);
  const ratio = zlib.deflateSync(ks, { level: 9 }).length / n;
  return { entropy: ent, chiSquare: chi, chiP: gammaQ(255 / 2, chi / 2), monobitP: monobit, runsP, serialCorr: corr, compression: ratio };
}

/* ------------------------------------------------------------ cycle analysis */
const fmap = (x) => R * x * (1 - x);
/** Brent's method: the length of the cycle (lambda) and of the tail before it (mu). */
function tailAndCycle(x0) {
  let power = 1, lam = 1, tort = x0, hare = fmap(x0);
  while (tort !== hare) { if (power === lam) { tort = hare; power *= 2; lam = 0; } hare = fmap(hare); lam++; }
  let x = tort, min = x; for (let i = 0; i < lam; i++) { x = fmap(x); if (x < min) min = x; }
  tort = x0; hare = x0; for (let i = 0; i < lam; i++) hare = fmap(hare);
  let mu = 0; while (tort !== hare) { tort = fmap(tort); hare = fmap(hare); mu++; }
  return { lambda: lam, mu, fingerprint: lam + ':' + min };
}
function cycleAnalysis(seeds) {
  const prints = new Set(), tails = []; let lambda = 0;
  for (let i = 0; i < seeds; i++) {
    const r = tailAndCycle(seedFor('evaluation-key', i));
    prints.add(r.fingerprint); tails.push({ i, mu: r.mu }); lambda = r.lambda;
  }
  tails.sort((a, b) => a.mu - b.mu);
  return { seeds, distinct: prints.size, lambda, minTail: tails[0].mu, medianTail: tails[Math.floor(tails.length / 2)].mu, shortestSeed: tails[0].i };
}
/** Does one long keystream repeat? Compares each byte with the byte one cycle length earlier. */
function repetitionDemo(mode, cycle) {
  const n = 20 * MiB;
  const ks = mode === 'basic' ? chaosCrypt(Buffer.alloc(n), seedFor('evaluation-key', cycle.shortestSeed)) : perturbedCrypt(Buffer.alloc(n), material('evaluation-key', cycle.shortestSeed));
  const from = cycle.minTail + cycle.lambda;
  let equal = 0; for (let i = from; i < n; i++) if (ks[i] === ks[i - cycle.lambda]) equal++;
  return { bytesCompared: n - from, equalFraction: equal / (n - from) };
}

/* ------------------------------------------------------------------- run */
function sharedWindows(mode, segBytes, segments, windowsPerSegment) {
  const ks = Array.from({ length: segments }, (_, i) => MODES[mode].keystream('overlap-key', 'seg' + i, segBytes));
  let pairs = 0, hit = 0;
  for (let i = 0; i < segments; i++) for (let j = i + 1; j < segments; j++) {
    pairs++;
    let found = false;
    for (let w = 0; w < windowsPerSegment && !found; w++) {
      const pos = crypto.randomInt(0, segBytes - 16);
      if (ks[i].indexOf(ks[j].subarray(pos, pos + 16)) >= 0) found = true;
    }
    if (found) hit++;
  }
  return { pairs, sharing: hit };
}

const report = {};
const pct = (x) => (100 * x).toFixed(2) + '%';
console.log('Chaos map cipher evaluation\n');

const cycle = cycleAnalysis(10);
console.log('CYCLE ANALYSIS (plain logistic map in double precision)');
console.log('  seeds tested: ' + cycle.seeds + ', all fall onto ' + cycle.distinct + ' repeating cycle of ' + cycle.lambda + ' states');
console.log('  steps before an orbit joins the cycle: shortest ' + cycle.minTail + ', median ' + cycle.medianTail);
console.log('  among the seeds tested, one stream was safe for at least about ' + ((cycle.minTail + cycle.lambda) / MiB).toFixed(1) + ' MiB and repeats beyond that, which is why every 4 MiB segment gets its own seed');
console.log('  the seed itself has 52 bits, so the nominal key space is 2^52, small by modern standards\n');
report.cycle = cycle;

for (const mode of Object.keys(MODES)) {
  console.log('== ' + mode.toUpperCase() + ' CIPHER');
  const r = {};
  let t0 = performance.now();
  MODES[mode].keystream('speed-key', 'speed', 16 * MiB);
  r.throughputMiBs = 16 / ((performance.now() - t0) / 1000);
  console.log('  throughput: ' + r.throughputMiBs.toFixed(1) + ' MiB per second');

  const ks = MODES[mode].keystream('evaluation-key', 'stat', 4 * MiB);
  r.randomness = randomness(ks);
  const q = r.randomness;
  console.log('  keystream of 4 MiB: entropy ' + q.entropy.toFixed(5) + ' bits per byte (ideal 8), chi square p ' + q.chiP.toFixed(3) + ', monobit p ' + q.monobitP.toFixed(3) + ', runs p ' + q.runsP.toFixed(3) + ', serial correlation ' + q.serialCorr.toFixed(5) + ', compression ratio ' + q.compression.toFixed(4));

  const k1 = MODES[mode].keystream('0.3141592653589793', 'seg', MiB), k2 = MODES[mode].keystream('0.3141592653589794', 'seg', MiB);
  r.keySensitivity = bitDiff(k1, k2) / (MiB * 8);
  console.log('  key sensitivity: changing the last digit of the key changes ' + pct(r.keySensitivity) + ' of keystream bits (ideal 50%)');

  const plain = crypto.randomBytes(MiB), enc = MODES[mode].crypt('right-key', 'seg', plain), wrong = MODES[mode].crypt('wrong-key', 'seg', enc);
  r.wrongKey = bitDiff(plain, wrong) / (MiB * 8);
  console.log('  decrypting with a wrong key leaves ' + pct(r.wrongKey) + ' of bits different from the plaintext (ideal 50%)');

  const flipped = Buffer.from(plain); flipped[1000] ^= 1;
  r.avalancheBits = bitDiff(MODES[mode].crypt('right-key', 'seg', plain), MODES[mode].crypt('right-key', 'seg', flipped));
  console.log('  flipping one plaintext bit flips ' + r.avalancheBits + ' ciphertext bit(s): a keystream cipher gives no diffusion, so integrity must come from SHA 256');

  const a = MODES[mode].keystream('overlap-key', 'a', 4 * MiB), b = MODES[mode].keystream('overlap-key', 'b', 4 * MiB);
  let same = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  let found = 0; const sample = 200;
  for (let w = 0; w < sample; w++) { const pos = crypto.randomInt(0, b.length - 16); if (a.indexOf(b.subarray(pos, pos + 16)) >= 0) found++; }
  r.segments4MiB = { sameByteFraction: same / a.length, sharedWindowFraction: found / sample };
  console.log('  two 4 MiB segments: ' + pct(same / a.length) + ' of bytes equal at the same position (random: 0.39%), ' + pct(found / sample) + ' of sampled 16 byte windows of one also occur in the other');
  const sw = sharedWindows(mode, 262144, 20, 8);
  r.segments256KiB = sw;
  console.log('  twenty 256 KiB segments: ' + sw.sharing + ' of ' + sw.pairs + ' pairs share keystream');

  const rep = repetitionDemo(mode, cycle);
  r.longStreamRepetition = rep;
  console.log('  one 20 MiB stream under a single seed: ' + pct(rep.equalFraction) + ' of bytes beyond the first cycle equal the byte one cycle earlier (random: 0.39%)' + (rep.equalFraction > 0.9 ? ', so the keystream repeats and must not be used for long streams' : ', so no repetition'));
  console.log('');
  report[mode] = r;
}

const out = path.join(__dirname, '..', 'evidence');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'cipher_evaluation.json'), JSON.stringify(report, null, 2));
console.log('Saved evidence/cipher_evaluation.json');
