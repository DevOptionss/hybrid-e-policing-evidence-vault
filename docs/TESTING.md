# Testing

All test scripts are in `vault/tests` and call the running server's HTTP interface, so they exercise the same code as the web page. They work in demo mode and against Fabric. Start the server first (see `docs/SETUP.md`). Run them from the `vault` folder.

## What each script checks

| Script | Tests | Checks |
|---|---|---|
| `objective3-tests.js` | 7 | Registration and verification, a flipped bit, an altered copy, a swapped copy, the outsider refused, the read only verifier, custody rules |
| `objective4-tests.js` | 14 | Footage, audio and a photograph. A flipped bit, a removed segment, swapped segments, truncation and a foreign segment all located. An edited manifest. A sensor reading edited. A batch gap and a replay refused. Roles. A large file. Cloud failover |
| `objective5-tests.js` | 6 | A three step custody chain recomputed independently, six forgeries of the trail caught, a refused handover leaving no mark, who may read a trail, custody of a CCTV record |
| `detection-trial.js` | 600 checks | 100 random bit changes and 100 untouched copies for each of footage, a photograph and a sensor batch, with 95 percent intervals |
| `cipher-evaluation.js` | | Throughput, randomness measures, key sensitivity, cycle length, repetition of a long stream and shared keystream between segments, for both ciphers. Needs no server |
| `benchmark.js` | | Registration and verification time at 100 KB, 1 MB, 5 MB and 25 MB, mean and standard deviation over 10 runs |
| `benchmark4.js` | | Ingestion and verification of 10 MB and 100 MB recordings, manifest overhead, ledger commit, sensor batching against one transaction per reading, a centralised baseline, storage tiers |
| `large-file-test.js` | | A large file ingested and verified, with server memory reported as total, heap and buffers |

Chaincode unit tests (23, no network needed):

```
cd chaincode/evidence-cc
npm install
npm test
```

On a live Fabric network, `fabric-scripts/smoke-v11.sh` runs 12 checks of the custody chain, manifests, sensor batches and role refusals through the peer command line.

## Running them

```
node tests/objective3-tests.js
node tests/objective4-tests.js
node tests/objective5-tests.js
node tests/detection-trial.js
node tests/cipher-evaluation.js
node tests/benchmark.js
node tests/benchmark4.js
node tests/large-file-test.js
```

or `.\run-all.ps1` on Windows to run all of them and save each output in `vault/evidence`.

## Settings for the tests

| Variable | Default | Meaning |
|---|---|---|
| `BASE` | `http://localhost:3000` | Address of the server. Set it if you changed `PORT` |
| `LARGE_MB` | `100` for `objective4-tests.js`, `500` for `large-file-test.js` | Size of the large file test in MB. A 500 MB run needs about 3 GB of free disk space |
| `TRIALS` | `100` | Trials per evidence type in the detection trial |
| `BENCH4_SIZES` | `10,100` | File sizes in MB for `benchmark4.js` |
| `BENCH_SIZES` | all four sizes | Sizes for `benchmark.js`, for example `100KB,1MB` |

## What to expect

- Every functional test should pass, in demo mode and on Fabric. `objective4-tests.js` skips the cloud failover test if the server was started without `CLOUD_IPFS_API`.
- **Timings in demo mode are not meaningful.** The in memory ledger commits in a fraction of a millisecond. Real ledger timings need Fabric. On the author's laptop a Fabric commit took about 2.1 seconds whatever the file size. See `docs/RESULTS.md`.
- The tests create records. Run them on a throwaway network.
- The detection trial reports 100 percent detection. That follows from the properties of SHA-256. It shows that the implementation applies the check correctly and that location works.
