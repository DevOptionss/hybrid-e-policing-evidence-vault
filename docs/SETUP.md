# Setup guide

There are two ways to run the project.

| Route | What you get | Time | You need |
|---|---|---|---|
| **A. Demo mode** | The full vault, IPFS storage and every test, with the chaincode logic running in memory instead of on a Fabric network | About 15 minutes | Node.js and an IPFS node |
| **B. Full setup** | The same, with a real Hyperledger Fabric network of two organisations | About 2 hours, mostly downloads | Everything in route A plus Docker, and on Windows WSL 2 |

Start with route A. It shows what the project does. Move to route B when you want the real ledger.

The project was developed and tested on Windows 11 with WSL 2. Route A was also run on Linux. Native Linux for route B should work but has not been tested.

## Route A: demo mode

### A1. Install the tools

| Tool | Version used | Where to get it |
|---|---|---|
| Node.js | 20 or newer (24 on Windows, 22 on Linux) | https://nodejs.org |
| Kubo (the IPFS node) | 0.43.1 | https://docs.ipfs.tech/install/command-line/ |
| FFmpeg | any recent version | Windows: `winget install Gyan.FFmpeg`. Linux: `sudo apt install ffmpeg`. FFmpeg is needed by the Objective 4 tests and for video time windows |

Check them in a new terminal:

```
node --version
ipfs --version
ffprobe -version
```

### A2. Start the IPFS node

```
ipfs init
ipfs daemon
```

Wait for `Daemon is ready` and leave that terminal open. On Windows, if the daemon stops with a message about the gateway port 8080, move the gateway once and start it again:

```
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/18080
```

### A3. Optional: a second node as the cloud tier

This lets you run the failover test and the replication timings.

```
export IPFS_PATH=$HOME/.ipfs-cloud        # Windows PowerShell: $env:IPFS_PATH="C:\ipfs-cloud"
ipfs init
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5002
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/18081
ipfs daemon --offline
```

Use a separate terminal and leave it open.

### A4. Start the vault server

```
cd vault
npm install
export CLOUD_IPFS_API=http://127.0.0.1:5002/api/v0     # only if you started the second node
                                                        # Windows PowerShell: $env:CLOUD_IPFS_API="http://127.0.0.1:5002/api/v0"
node server.js --demo
```

You should see the IPFS node connected, the ledger as `memory` with 4 identities, and `Open http://localhost:3000`. Open that address in a browser. Use the account menu to switch between an administrator, an investigator, a read only verifier and an outsider.

### A5. Run the tests

In a second terminal, in the `vault` folder:

```
node tests/objective3-tests.js
node tests/objective4-tests.js
node tests/objective5-tests.js
node tests/detection-trial.js
node tests/cipher-evaluation.js
```

All should pass. See `docs/TESTING.md` for what each one checks and for the settings you can change.

## Route B: full setup with Hyperledger Fabric

### B1. What you need

| Item | Recommendation |
|---|---|
| Computer | Windows 11 with at least 12 GB of memory and 15 GB of free disk space. Hardware virtualisation must be switched on in the BIOS |
| WSL 2 with Ubuntu | `wsl --install` in an administrator PowerShell, then restart |
| Docker Desktop | With the WSL 2 engine and Ubuntu integration switched on |
| Node.js, Kubo, FFmpeg | As in route A, installed on Windows |

### B2. Limit the memory WSL can take

Without a limit WSL can use most of the computer's memory. In PowerShell:

```
@"
[wsl2]
memory=6GB
swap=4GB
"@ | Out-File -Encoding ascii $HOME\.wslconfig
wsl --shutdown
```

### B3. Connect Docker to Ubuntu

Open Docker Desktop. Under Settings, then General, tick "Use the WSL 2 based engine". Under Settings, then Resources, then WSL integration, switch on Ubuntu and press Apply and Restart. Open Ubuntu and check:

```
docker --version
docker run hello-world
sudo apt update && sudo apt install -y git curl jq unzip
```

### B4. Get this repository into Ubuntu

Clone the repository on Windows, or clone it inside Ubuntu. Then copy the chaincode and the scripts into the place the scripts expect, which is `~/fabric`:

```
mkdir -p ~/fabric
git clone https://github.com/<your-account>/hybrid-e-policing-evidence-vault.git ~/hybrid-e-policing-evidence-vault
cp -r ~/hybrid-e-policing-evidence-vault/chaincode/evidence-cc ~/fabric/
cp -r ~/hybrid-e-policing-evidence-vault/fabric-scripts ~/fabric/scripts
chmod +x ~/fabric/scripts/*.sh
```

### B5. Download Fabric

This pulls the Docker images, the sample network and the command line tools. It is several gigabytes.

```
cd ~/fabric
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh docker samples binary
```

The project used Fabric 2.5.16. If a download stops with an HTTP/2 error, use the resumable fallback in `docs/TROUBLESHOOTING.md`.

Check that the tools work:

```
ls ~/fabric/fabric-samples
~/fabric/fabric-samples/bin/peer version
```

### B6. Reserve the ports Windows must not take

Windows can reserve blocks of ports for itself, and when that happens Docker cannot publish Fabric's ports. Reserve the ones this project needs once. In an **administrator** PowerShell:

```
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=9443 numberofports=3
netsh int ipv4 add excludedportrange protocol=tcp startport=7050 numberofports=4
netsh int ipv4 add excludedportrange protocol=tcp startport=9051 numberofports=1
netsh int ipv4 add excludedportrange protocol=tcp startport=3000 numberofports=1
netsh int ipv4 add excludedportrange protocol=tcp startport=5001 numberofports=2
netsh int ipv4 add excludedportrange protocol=tcp startport=18080 numberofports=2
net start winnat
netsh interface ipv4 show excludedportrange protocol=tcp
```

Your ranges should now appear in the list marked with an asterisk. If a command says a range overlaps one Windows already reserved, run `net stop winnat` first and repeat.

### B7. Start the Fabric network and deploy the chaincode

In Ubuntu:

```
cd ~/fabric/fabric-samples/test-network
./network.sh down
./network.sh up createChannel -c mychannel
~/fabric/scripts/deploy-evidence.sh 1.1
~/fabric/scripts/setup-roles.sh
```

The deploy builds the chaincode container and downloads packages, so it takes several minutes. If it ends with a timeout, run the same command again. The roles script should finish with four lines:

```
Org1 Admin   {"mspId":"Org1MSP","role":"admin"}
Org1 User1   {"mspId":"Org1MSP","role":"investigator"}
Org2 Admin   {"mspId":"Org2MSP","role":"verifier"}
Org2 User1   {"mspId":"Org2MSP","role":null}
```

Optionally run the chaincode smoke test, which checks the custody chain, a manifest, sensor batches and the role refusals on the live network:

```
~/fabric/scripts/smoke-v11.sh
```

### B8. Set up the Windows side

1. Put `ipfs.exe` in `C:\ipfs` and add that folder to the Windows PATH.
2. Create the second IPFS repository once (the cloud tier) as in step A3, using `C:\ipfs-cloud`.
3. Install the vault's packages:

```
cd vault
npm install
```

Check that Windows can reach Fabric:

```
Test-NetConnection localhost -Port 7051
Test-NetConnection localhost -Port 9051
```

Both should say `TcpTestSucceeded : True`.

### B9. Run everything

Open three PowerShell windows and leave them open.

Window 1, the on premise IPFS node:

```
ipfs daemon
```

Window 2, the cloud IPFS node:

```
$env:IPFS_PATH="C:\ipfs-cloud"
ipfs daemon --offline
```

Window 3, the vault server:

```
cd vault
$env:CLOUD_IPFS_API="http://127.0.0.1:5002/api/v0"
node server.js
```

The server prints three lines: IPFS connected, the ledger as `fabric` on `mychannel` with 4 identities, and the address. Open http://localhost:3000. It starts in live mode.

The server reads the Fabric certificates from the Ubuntu folder through the Windows path `\\wsl.localhost\Ubuntu\home\ubuntu\fabric\fabric-samples\test-network\organizations`. If your Ubuntu distribution or user name differs, set `WSL_DISTRO` and `WSL_USER`. If Windows cannot read that path, copy the folder and point to the copy:

```
# Ubuntu
cp -r ~/fabric/fabric-samples/test-network/organizations /mnt/c/Users/<you>/fabric-crypto
# PowerShell
$env:FABRIC_CRYPTO="C:\Users\<you>\fabric-crypto"
node server.js
```

Keep that copied folder out of the repository. It holds private keys.

### B10. Run the tests

In a fourth window, in the `vault` folder, either run the scripts one at a time as in step A5, or run them all and save every output in `vault/evidence`:

```
.\run-all.ps1
```

It takes about half an hour and the 500 MB test needs about 3 GB of free disk space. If PowerShell refuses to run it, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first.

## After a restart

Nothing starts on its own. In order:

1. Start Docker Desktop and wait until the engine is running.
2. In Ubuntu run `~/fabric/scripts/resume-network.sh`. It restarts the stopped Fabric containers and keeps the ledger.
3. Check the chaincode answers. The first query can take a minute:

```
~/fabric/scripts/make-org1-env.sh
source ~/fabric/org1.env
peer chaincode query -C mychannel -n evidence -c '{"function":"WhoAmI","Args":[]}'
```

   You want `"role":"admin"`. If you get "chaincode evidence not found", the ledger was wiped. Repeat step B7.
4. Start the two IPFS nodes and the vault server as in step B9.

## Starting again from nothing

```
cd ~/fabric/fabric-samples/test-network
./network.sh down
```

Then repeat step B7. The network is rebuilt with new identities, so restart the vault server afterwards so that it reads the new certificates. Records from before the reset are gone.

If you changed the cipher mode (`CHAOS_MODE`), evidence saved under the other mode cannot be decrypted. Start the server with the same mode that was used to save it.

More help is in `docs/TROUBLESHOOTING.md`.
