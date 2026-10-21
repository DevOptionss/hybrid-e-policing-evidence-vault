'use strict';
/**
 * Large files create many short lived buffers. Node frees them lazily, and on a machine with plenty of memory
 * it may wait a long time, so the server asks for a collection every few segments. The function is obtained at
 * run time, so the server needs no special start up flag. Set VAULT_GC_EVERY=0 to switch this off.
 */
let collect = null;
try {
  require('v8').setFlagsFromString('--expose_gc');
  collect = require('vm').runInNewContext('gc');
} catch (e) { /* not available */ }

const every = process.env.VAULT_GC_EVERY === undefined ? 4 : Number(process.env.VAULT_GC_EVERY);

function maybeGc(i) {
  if (collect && every > 0 && i % every === every - 1) collect();
}

module.exports = { maybeGc };
