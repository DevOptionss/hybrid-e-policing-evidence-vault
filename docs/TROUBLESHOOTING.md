# Troubleshooting

Every problem below was met while building this project.

| What you see | Why it happens | Fix |
|---|---|---|
| `docker` not found inside Ubuntu | Docker Desktop's WSL integration is off | Docker Desktop, Settings, Resources, WSL integration, switch on Ubuntu, Apply and Restart, then `wsl -t Ubuntu` and reopen Ubuntu |
| `ports are not available: exposing port TCP 0.0.0.0:9443` when starting containers | Windows reserved that port block for itself | In an administrator PowerShell run `net stop winnat`, start the containers again, then `net start winnat`. Reserve the ports as in `docs/SETUP.md` step B6 |
| `listen EACCES 127.0.0.1:3000` from the vault server | The port is inside a block Windows reserved | Check `netsh interface ipv4 show excludedportrange protocol=tcp` and start the server on another port: `$env:PORT=3100; node server.js`. Tests then need `$env:BASE="http://localhost:3100"` |
| IPFS stops with `serveHTTPGateway ... bind: ... forbidden by its access permissions` | The gateway port 8080 is reserved | `ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/18080`, then start the daemon again |
| `EPERM ... C:\Windows\package.json` | The terminal is in `C:\Windows` because it was opened as administrator | Close it, open a normal terminal, and work from your own folder |
| `install-fabric.sh` fails with an HTTP/2 or early EOF error | The connection dropped during a large download | Use the resumable fallback below |
| Chaincode install ends with `timeout expired` | The peer was still building the chaincode container | Run the same `deploy-evidence.sh` command again |
| `chaincode evidence not found on channel mychannel` | The ledger was wiped, for example after `network.sh down` or a Docker reset | Repeat `docs/SETUP.md` step B7 |
| `Not authorised` while running `setup-roles.sh` | A call ran before the previous block committed | Run `setup-roles.sh` again. The shipped version already waits four seconds after each write |
| Vault server says `IPFS node NOT reachable` | The IPFS daemon is not running or uses another port | Start `ipfs daemon`. If the API is on another port, set `IPFS_API=http://127.0.0.1:<port>/api/v0` |
| The page's Live button will not switch | IPFS or the ledger is not ready | Open `http://localhost:3000/api/status` and read `"ready"`, `"ipfs"` and `"error"` |
| `fetch failed` from a test script | The server is not running, or the tests point at the wrong port | Start the server and set `BASE` if you changed the port |
| Server cannot read the Fabric certificates | The `\\wsl.localhost` path is wrong or unreadable | Set `WSL_DISTRO` and `WSL_USER`, or copy the folder and set `FABRIC_CRYPTO` as in `docs/SETUP.md` |
| Saved records show as altered after a restart or an upgrade | They were saved under a different cipher mode | Start the server with the same `CHAOS_MODE` that saved them, or rebuild the network |
| Server memory grows on a very large file | An older version kept copies of every segment | Use the current code. `VAULT_GC_EVERY=4` (the default) collects memory every four segments |
| The test footage cannot be created | FFmpeg is not installed or not on the PATH | Install it and open a new terminal |

## Resumable Fabric download

If `install-fabric.sh` fails, fetch the pieces separately. These commands carry on from where they stopped when you run them again.

```
cd ~/fabric
git config --global http.version HTTP/1.1
until git clone --depth 1 https://github.com/hyperledger/fabric-samples.git; do rm -rf fabric-samples; sleep 5; done
cd fabric-samples
curl -L -C - --http1.1 --retry 30 --retry-delay 5 --retry-all-errors -o fabric-bin.tar.gz \
  https://github.com/hyperledger/fabric/releases/download/v2.5.16/hyperledger-fabric-linux-amd64-2.5.16.tar.gz
tar xzf fabric-bin.tar.gz
cd ~/fabric
./install-fabric.sh docker
```

If Docker stops partway through the images, run the last command again. Layers already downloaded are kept.
