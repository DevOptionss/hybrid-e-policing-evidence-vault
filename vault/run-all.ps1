# Runs every test and measurement in order and saves the output in the evidence folder.
# Start first: the IPFS node, the cloud IPFS node, and the server (node server.js) with CLOUD_IPFS_API set.
#   cd $HOME\fabric-vault
#   .\run-all.ps1
# If PowerShell refuses to run scripts:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path evidence | Out-Null
if (-not $env:LARGE_MB) { $env:LARGE_MB = "500" }
$steps = @(
  @{ name = "Objective 3 tests (and regression check T16)"; cmd = "node tests\objective3-tests.js";   out = "evidence\tests_output.txt" },
  @{ name = "Objective 3 benchmark";                        cmd = "node tests\benchmark.js";         out = "evidence\benchmark_output.txt" },
  @{ name = "Objective 4 tests (includes the large file test)"; cmd = "node tests\objective4-tests.js"; out = "evidence\tests4_output.txt" },
  @{ name = "Large file memory test";                       cmd = "node tests\large-file-test.js";   out = "evidence\large_file_output.txt" },
  @{ name = "Objective 5 custody tests";                    cmd = "node tests\objective5-tests.js";  out = "evidence\tests5_output.txt" },
  @{ name = "Tamper detection trial";                       cmd = "node tests\detection-trial.js";   out = "evidence\detection_trial.txt" },
  @{ name = "Objective 4 benchmark";                        cmd = "node tests\benchmark4.js";        out = "evidence\benchmark4_output.txt" },
  @{ name = "Chaos cipher evaluation (offline)";            cmd = "node tests\cipher-evaluation.js"; out = "evidence\cipher_evaluation.txt" }
)
$i = 0
foreach ($s in $steps) {
  $i++
  Write-Host ""
  Write-Host ("[$i of " + $steps.Count + "] " + $s.name) -ForegroundColor Cyan
  Invoke-Expression ($s.cmd + " | Tee-Object " + $s.out)
  if ($LASTEXITCODE -ne 0) { Write-Host "   -> finished with exit code $LASTEXITCODE (see the output above)" -ForegroundColor Yellow }
}
Write-Host ""
Write-Host "Done. Outputs are in the evidence folder:" -ForegroundColor Green
Get-ChildItem evidence | Select-Object Name, Length
