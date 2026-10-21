# Output of the complete evidence run

This is the unedited console output of `run-all.ps1` on the author's laptop (Windows 11 Pro, Intel Core i7 8565U, 12 GB RAM, Hyperledger Fabric 2.5.16 test network, two IPFS nodes, chaincode version 1.1). It contains the Objective 3 tests and benchmark, the Objective 4 tests, the large file test, the Objective 5 custody tests, the tamper detection trial, the Objective 4 benchmark and the chaos map cipher evaluation. Timings describe relative behaviour on one machine and will differ on other hardware.

```text
[1 of 8] Objective 3 tests (and regression check T16)
Ledger: fabric | IPFS 0.43.1

TEST 1: genuine evidence is saved and verifies
  PASS  Evidence 1 verified: true
TEST 2: an altered file (one bit flipped) is compared with the ledger hash
  PASS  Original matches: true, altered matches: false
TEST 3: the altered content receives a different content ID
  PASS  Registered Qmb6e5Y6TLgXoGmTKeQCCsGfXgUeWKWw2eJhYezEyBTSMc against altered QmRPJ13b1WEBcQRvwpRdamXAUXVESFHzoTy6UNEuxZLmuh, original intact: true
TEST 4: a record is made to point at the altered copy
  PASS  Evidence 2 verification result: false
TEST 5: an unauthorised identity tries to register evidence
  PASS  HTTP 403: Refused by the chaincode: Not authorised
TEST 6: a verifier can read and check but cannot register
  PASS  Save: HTTP 403, check intact: true
TEST 7: custody can only be handed over by the current custodian
  PASS  B: 403, A: 200, A again: 403 (Refused by the chaincode: Not custodian)

Summary
Test | Scenario | Expected | Result
1 | Register and verify genuine evidence | Verification passes | PASS
2 | Compare an altered file with the ledger hash | Original matches, altered does not | PASS
3 | Add the altered copy to IPFS | A different content ID, original untouched | PASS
4 | Swap the stored copy behind a record | Verification fails | PASS
5 | Unauthorised identity registers evidence | Refused by the chaincode | PASS
6 | Read only verifier | Save refused, check allowed | PASS
7 | Custody rules | Non custodian refused, custodian accepted, former custodian then refused | PASS

7 of 7 tests passed.

[2 of 8] Objective 3 benchmark
100KB  register 2258.2 ms (sd 55.8)  verify 69.5 ms (sd 9.3)
1MB  register 2419.2 ms (sd 31.6)  verify 256 ms (sd 28.5)
5MB  register 3315.1 ms (sd 140.7)  verify 1030.1 ms (sd 77.8)
25MB  register 7137.6 ms (sd 122.2)  verify 4638 ms (sd 28.7)

size | metric | mean ms | sd | min | max
100KB | hash | 0.6 | 0.1 | 0.5 | 0.8
100KB | encrypt | 16.2 | 6.8 | 12.5 | 34.1
100KB | ipfs_upload | 72.9 | 15.1 | 57.7 | 104
100KB | ledger_commit | 2114.9 | 10 | 2099.1 | 2132.9
100KB | register_total | 2258.2 | 55.8 | 2213 | 2402.3
100KB | verify_total | 69.5 | 9.3 | 57.6 | 85.8
1MB | hash | 6.3 | 1.1 | 5.4 | 9.3
1MB | encrypt | 149.8 | 5.7 | 141.3 | 157.7
1MB | ipfs_upload | 106.8 | 17.3 | 86.8 | 148.8
1MB | ledger_commit | 2112.6 | 19.6 | 2097.9 | 2158.5
1MB | register_total | 2419.2 | 31.6 | 2389 | 2492.4
1MB | verify_total | 256 | 28.5 | 232.3 | 330.9
5MB | hash | 30.9 | 3.2 | 28.2 | 38.8
5MB | encrypt | 756.8 | 57.3 | 712.6 | 915.3
5MB | ipfs_upload | 341.2 | 103.5 | 231 | 539.3
5MB | ledger_commit | 2121 | 23.6 | 2095.6 | 2162.3
5MB | register_total | 3315.1 | 140.7 | 3149.9 | 3555.2
5MB | verify_total | 1030.1 | 77.8 | 949.9 | 1182
25MB | hash | 147.2 | 6.1 | 133.5 | 153.7
25MB | encrypt | 3649.9 | 38.4 | 3589.9 | 3695.8
25MB | ipfs_upload | 1057.1 | 123.4 | 909.3 | 1310.1
25MB | ledger_commit | 2134 | 21 | 2097.2 | 2161.4
25MB | register_total | 7137.6 | 122.2 | 6978.5 | 7391.6
25MB | verify_total | 4638 | 28.7 | 4600.5 | 4687.6

Saved evidence/benchmark.csv

[3 of 8] Objective 4 tests (includes the large file test)
Ledger: fabric | IPFS 0.43.1 | cloud tier: on

Test footage: 1716594 bytes in 7 segments of 262144 bytes

TEST 1: genuine footage, audio and photograph are ingested and verified
  PASS  CCTV 7 segments (time index ffprobe), audio 3, photo 2, all verified: true, hashes match originals: true
TEST 2: one bit flipped inside one segment of the footage
  PASS  kind altered, changed [4], segment 4 window 17:31:23 to 17:31:28
TEST 3: one segment removed from the footage
  PASS  kind deleted at 3, missing [3]
TEST 4: two segments swapped
  PASS  kind reordered, changed [2,5]
TEST 5: the end of the recording cut off
  PASS  kind truncated, missing [5,6]
TEST 6: a segment from another recording inserted in place of segment 1
  PASS  kind altered, changed [1]
TEST 7: a segment hash edited inside the manifest
  PASS  evidence 46: root ok false, verified false
TEST 8: one bit flipped in a photograph
  PASS  altered file matches: false, original matches: true
TEST 9: one sensor reading edited inside a batch
  PASS  3 batches anchored, device verified true, edited batch changed readings [17], untouched batch matches true
TEST 10 and 11: a gap in the batch index and a replayed batch
  PASS  HTTP 403: Refused by the chaincode: Batch index out of sequence, expected 4
  PASS  HTTP 403: Refused by the chaincode: Batch already anchored
TEST 12: roles on the media functions
  PASS  outsider ingest 403, verifier ingest 403, verifier verify ok true, outsider anchor 403
TEST 13: a large file is ingested and verified without loading it into memory (500 MB)
  PASS  500 MB in 125 segments, ingest 122 s, verify 100 s, verified true, server memory 132 MB before and 319 MB at the peak
TEST 14: retrieval and verification from the cloud node while the on premise node is unavailable
  PASS  verified true, segments read from premise 0 and from cloud 8

Summary
Test | Scenario | Expected | Result
1 | Ingest and verify footage, audio and photograph | All pass and file hashes match the originals | PASS
2 | Flip one bit in one segment | Fails and names the segment and its time window | PASS
3 | Remove one segment | The missing segment is reported | PASS
4 | Swap two segments | The reordering is reported | PASS
5 | Cut the last segments | Truncation is reported | PASS
6 | Foreign segment | The substituted segment is reported | PASS
7 | Edit the manifest | The rebuilt Merkle root differs from the anchored root | PASS
8 | Flip one bit in a photograph | Hash mismatch against the ledger | PASS
9 | Edit one sensor reading | The batch root no longer matches and the reading is named | PASS
10 | Gap in the batch index | Refused by the chaincode | PASS
11 | Replay of an old batch | Refused by the chaincode | PASS
12 | Outsider and verifier | Writes refused, verification allowed | PASS
13 | Large file without loading it into memory | Completes, with server memory staying under 512 MB | PASS
14 | Cloud failover | Verification succeeds using the cloud node only | PASS

14 of 14 tests passed. (Test 15, the detection rate trial, and test 16, the Objective 3 regression, run separately.)

[4 of 8] Large file memory test
File: 500 MB. Cloud tier: on
Ingest:  115.2 s for 125 segments (hash 5953.7 ms, encrypt 69861.7 ms, IPFS 19108.6 ms, replicate 16585.8 ms, ledger 2194.9 ms)
Verify:  100.0 s, verified true
Memory before: total 279 MB, heap 27 MB, buffers 7 MB
Memory peak:   total 345 MB, heap 83 MB, buffers 56 MB

PASS  server memory stayed under 512 MB for a 500 MB file

[5 of 8] Objective 5 custody tests
Ledger: fabric

TEST C1: a three step chain of custody, checked independently
  PASS  entries 3, holders Investigator A (administrator) then Investigator B then Investigator A (administrator), independent check valid, server check true
TEST C2: the trail is tied to the evidence file itself
  PASS  real file matches the first link: true, a different file hash gives 1 problem(s)
TEST C3: forged copies of the trail are detected
  PASS  a custodian name changed: caught, the middle entry removed: caught, two entries swapped: caught, a time edited: caught, an entry added: caught, the last entry removed: caught
TEST C4: a refused handover leaves no mark on the trail
  PASS  HTTP 403 (Refused by the chaincode: Not custodian), entries still 3
TEST C5: who may read a trail
  PASS  outsider HTTP 403, verifier HTTP 200 with 3 entries
TEST C6: a media manifest has a chain of custody too
  PASS  entries 2, independent check valid, first link tied to the file hash true

Summary
Test | Scenario | Expected | Result
C1 | Register, hand over twice, verify the trail | Three linked entries, valid under independent recomputation | PASS
C2 | Link the chain to the file hash | Matches the real file, fails for any other file | PASS
C3 | Forge the trail six ways | Every forgery detected | PASS
C4 | Non custodian tries to take custody | Refused and the trail is unchanged | PASS
C5 | Outsider and verifier read the trail | Outsider refused, verifier allowed | PASS
C6 | Custody of a CCTV record | Two linked entries tied to the original file hash | PASS

6 of 6 tests passed.

[6 of 8] Tamper detection trial
Ledger: fabric | trials per kind: 100 (each trial is one changed copy and one untouched copy)

CCTV footage           detection 100.0% (95% interval 96.3% to 100.0%) | located correctly 100.0% (95% interval 96.3% to 100.0%) | false alarms 0.0% (95% interval 0.0% to 3.7%) | 77 ms per check
Photograph             detection 100.0% (95% interval 96.3% to 100.0%) | located correctly 100.0% (95% interval 96.3% to 100.0%) | false alarms 0.0% (95% interval 0.0% to 3.7%) | 58 ms per check
IoT sensor batch       detection 100.0% (95% interval 96.3% to 100.0%) | located correctly 100.0% (95% interval 96.3% to 100.0%) | false alarms 0.0% (95% interval 0.0% to 3.7%) | 82 ms per check

All kinds together: detection 100.0% (95% interval 98.7% to 100.0%), false alarms 0.0% (95% interval 0.0% to 1.3%)
Saved evidence/detection_trial.json

[7 of 8] Objective 4 benchmark
Ledger: fabric | cloud tier: on | sizes 10, 100 MB

B1 to B3: 10 MB recordings, 10 runs
  hash                                mean      120.6 ms   sd        3   min       115   max     124.3
  encrypt                             mean     1415.3 ms   sd     23.4   min    1379.3   max    1461.1
  ipfs                                mean      261.2 ms   sd       55   min     211.8   max     381.7
  replicate                           mean      250.4 ms   sd     41.2   min     212.7   max       355
  manifest                            mean       67.7 ms   sd      8.7   min      56.6   max      82.5
  ledger                              mean     2137.1 ms   sd     12.6   min    2124.4   max    2167.6
  total                               mean     4728.9 ms   sd    117.7   min    4594.2   max    5000.5
  verify                              mean     2002.8 ms   sd     56.2   min    1928.1   max    2068.2
  transactions per item               mean          1   sd        0   min         1   max         1
  manifest size overhead      0.009% of the file (3 segments)
B6 centralised baseline, 10 MB
  baseline store                      mean       76.4 ms   sd      5.4   min      66.9   max      83.1
  baseline verify                     mean       66.6 ms   sd      3.3   min      61.8   max      71.3

B1 to B3: 100 MB recordings, 5 runs
  hash                                mean     1197.4 ms   sd     39.8   min    1159.9   max    1256.6
  encrypt                             mean    14388.8 ms   sd    416.7   min   14004.7   max   14995.9
  ipfs                                mean     2866.1 ms   sd   1388.1   min    2088.5   max    5342.5
  replicate                           mean     2418.5 ms   sd   1184.4   min      1821   max    4535.6
  manifest                            mean       54.1 ms   sd      6.6   min      44.7   max      59.8
  ledger                              mean     2105.6 ms   sd     12.6   min    2088.5   max      2119
  total                               mean    23735.3 ms   sd   2977.9   min   21967.1   max   29014.1
  verify                              mean    20205.5 ms   sd    288.2   min   19846.3   max   20645.3
  transactions per item               mean          1   sd        0   min         1   max         1
  manifest size overhead      0.005% of the file (25 segments)
B6 centralised baseline, 100 MB
  baseline store                      mean      731.4 ms   sd     41.7   min     684.3   max     773.8
  baseline verify                     mean      623.2 ms   sd     36.2   min     565.2   max       652

B2 chaincode query latency (read of one custody trail, 20 calls)
  query latency                       mean       24.4 ms   sd      7.6   min      20.5   max      55.6

B4 IoT anchoring: 1000 readings, three batch sizes, 3 runs each
  time for 1000 readings (10 tx)      mean    23666.7 ms   sd     34.8   min   23634.6   max   23703.7
  time for 1000 readings (2 tx)       mean     6477.2 ms   sd     29.6   min    6449.3   max    6508.2
  time for 1000 readings (1 tx)       mean     4327.6 ms   sd       11   min    4317.6   max    4339.4
  time per reading (1 tx)             mean     2250.7 ms   sd     10.7   min    2243.2   max    2258.3
  one transaction per reading would take about 2250.7 s per 1000 readings (extrapolated from the measurement above)

B7 storage tiers: verification of a 10 MB recording, 5 runs each
  verify, on premise node             mean     2033.2 ms   sd     49.5   min    1990.3   max    2115.6
  verify, cloud node only             mean       2015 ms   sd       33   min    1975.4   max    2053.4
  replication to the cloud node is the "replicate" figure in B1

Saved evidence/benchmark4.csv

[8 of 8] Chaos cipher evaluation (offline)
Chaos map cipher evaluation

CYCLE ANALYSIS (plain logistic map in double precision)
  seeds tested: 10, all fall onto 1 repeating cycle of 6623920 states
  steps before an orbit joins the cycle: shortest 14034940, median 34525335
  among the seeds tested, one stream was safe for at least about 19.7 MiB and repeats beyond that, which is why every 4 MiB segment gets its own seed
  the seed itself has 52 bits, so the nominal key space is 2^52, small by modern standards

== BASIC CIPHER
  throughput: 41.2 MiB per second
  keystream of 4 MiB: entropy 7.99996 bits per byte (ideal 8), chi square p 0.462, monobit p 0.993, runs p 0.970, serial correlation -0.00104, compression ratio 1.0003
  key sensitivity: changing the last digit of the key changes 50.00% of keystream bits (ideal 50%)
  decrypting with a wrong key leaves 50.00% of bits different from the plaintext (ideal 50%)
  flipping one plaintext bit flips 1 ciphertext bit(s): a keystream cipher gives no diffusion, so integrity must come from SHA 256
  two 4 MiB segments: 0.39% of bytes equal at the same position (random: 0.39%), 0.00% of sampled 16 byte windows of one also occur in the other
  twenty 256 KiB segments: 0 of 190 pairs share keystream
  one 20 MiB stream under a single seed: 100.00% of bytes beyond the first cycle equal the byte one cycle earlier (random: 0.39%), so the keystream repeats and must not be used for long streams

== PERTURBED CIPHER
  throughput: 6.0 MiB per second
  keystream of 4 MiB: entropy 7.99995 bits per byte (ideal 8), chi square p 0.256, monobit p 0.827, runs p 0.268, serial correlation 0.00063, compression ratio 1.0003
  key sensitivity: changing the last digit of the key changes 50.03% of keystream bits (ideal 50%)
  decrypting with a wrong key leaves 49.95% of bits different from the plaintext (ideal 50%)
  flipping one plaintext bit flips 1 ciphertext bit(s): a keystream cipher gives no diffusion, so integrity must come from SHA 256
  two 4 MiB segments: 0.39% of bytes equal at the same position (random: 0.39%), 0.00% of sampled 16 byte windows of one also occur in the other
  twenty 256 KiB segments: 0 of 190 pairs share keystream
  one 20 MiB stream under a single seed: 0.39% of bytes beyond the first cycle equal the byte one cycle earlier (random: 0.39%), so no repetition

Saved evidence/cipher_evaluation.json

Done. Outputs are in the evidence folder:

Name                   Length
----                   ------
.keep                       0
benchmark.csv            1035
benchmark4.csv           1671
benchmark4_output.txt    7502
benchmark_output.txt     3018
cipher_evaluation.json   1624
cipher_evaluation.txt    4746
detection_trial.json      445
detection_trial.txt      1682
large_file_output.txt     730
tests4_output.txt        6280
tests5_output.txt        3194
tests_output.txt         3140
```
