# Installing the software

This page lists every program the project needs, how to install it, and how to check it worked. Do this before `docs/SETUP.md`.

## What you need

| Program | Needed for | Demo mode | Full setup with Fabric |
|---|---|---|---|
| Git | Getting the repository | Yes | Yes |
| Node.js 20 or newer | The vault server and the test scripts | Yes | Yes |
| Kubo (the IPFS node) | Storing the encrypted evidence | Yes | Yes |
| FFmpeg | Creating test footage and reading video timing | Yes, for the Objective 4 tests | Yes |
| WSL 2 with Ubuntu | Running Fabric on Windows | No | Yes, on Windows |
| Docker Desktop | Running the Fabric containers | No | Yes |

Python is not needed.

## Computer requirements

| Item | Demo mode | Full setup with Fabric |
|---|---|---|
| Operating system | Windows 10 or 11, Linux or macOS | Windows 11 (tested) or Linux |
| Memory | 4 GB | 12 GB recommended. The author used 12 GB with WSL limited to 6 GB |
| Free disk space | 2 GB | 15 GB, plus 3 GB for the 500 MB test |
| Virtualisation | Not needed | Must be switched on in the BIOS or UEFI |

To check virtualisation on Windows, open Task Manager, choose Performance, then CPU. It should say Virtualization: Enabled. If it says Disabled, switch it on in the BIOS or UEFI settings, which differ between makers.

## Windows 11

Open PowerShell. A normal window is enough unless a step says administrator. The `winget` commands need Windows 11 or an up to date Windows 10.

### 1. Git

```
winget install --id Git.Git -e
```

Close PowerShell, open a new window and check:

```
git --version
```

### 2. Node.js

```
winget install OpenJS.NodeJS.LTS
```

Open a new window and check. The version should be 20 or higher (the author used 24).

```
node --version
npm --version
```

### 3. FFmpeg

```
winget install Gyan.FFmpeg
```

Open a new window and check:

```
ffprobe -version
```

### 4. Kubo, the IPFS node

There is no installer. Download the zip and place one file.

1. Go to https://github.com/ipfs/kubo/releases and find release v0.43.1 (or the newest release).
2. Download the file ending in `windows-amd64.zip`. Check your processor first with `$env:PROCESSOR_ARCHITECTURE`. If it says `ARM64`, download `windows-arm64.zip` instead.
3. Extract the zip. Inside the `kubo` folder is `ipfs.exe`.
4. Create the folder `C:\ipfs` and copy `ipfs.exe` into it.
5. Add the folder to your PATH, then open a new PowerShell window:

```
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\ipfs", "User")
```

Check:

```
ipfs --version
```

If Windows says the program is "not a valid application for this OS platform", you downloaded the wrong build. Download the matching one again.

### 5. WSL 2 and Ubuntu (full setup only)

In PowerShell opened as **administrator**:

```
wsl --install
```

Restart when asked. Ubuntu then opens and asks you to create a user name and password. Use the user name `ubuntu` to match the defaults in this project. If you choose another name, set the `WSL_USER` variable later as described in `docs/SETUP.md`.

Check that Ubuntu runs as version 2:

```
wsl -l -v
```

The VERSION column must say 2. If it says 1, run `wsl --set-version Ubuntu 2`.

### 6. Docker Desktop (full setup only)

```
winget install -e --id Docker.DockerDesktop
```

Restart if asked, then open Docker Desktop from the Start menu and accept the terms. You can skip signing in. Docker Desktop is free for personal and educational use. Check Docker's current terms if you use it for a company.

Connect it to Ubuntu: open Settings, then General, and tick "Use the WSL 2 based engine". Then open Settings, Resources, WSL integration, switch on Ubuntu, and press Apply and Restart. Wait until the engine shows as running.

Open Ubuntu and check:

```
docker --version
docker run hello-world
```

The second command should print "Hello from Docker!". If Ubuntu says `docker` could not be found, the WSL integration switch is off or Docker Desktop is not running yet.

### 7. Tools inside Ubuntu (full setup only)

In Ubuntu:

```
sudo apt update
sudo apt install -y git curl jq unzip
```

`jq` is used by the Fabric scripts. To run the chaincode unit tests inside Ubuntu as well, which is optional, install Node.js there:

```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

### 8. A code editor (optional)

```
winget install Microsoft.VisualStudioCode
```

## Ubuntu or Debian Linux (demo mode, and Fabric untested)

```
sudo apt update
sudo apt install -y git curl ffmpeg jq unzip
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Install Kubo:

```
cd /tmp
curl -L -o kubo.tar.gz https://github.com/ipfs/kubo/releases/download/v0.43.1/kubo_v0.43.1_linux-amd64.tar.gz
tar xzf kubo.tar.gz
sudo bash kubo/install.sh
ipfs --version
```

For the full setup on Linux, install Docker Engine by following https://docs.docker.com/engine/install/ubuntu/ and add yourself to the docker group with `sudo usermod -aG docker $USER`, then log out and in. Native Linux for the full setup has not been tested. The server finds the Fabric certificates in `~/fabric/fabric-samples/test-network/organizations` on Linux.

## macOS (demo mode, untested)

With Homebrew installed:

```
brew install git node ffmpeg ipfs
```

The Homebrew package named `ipfs` is Kubo.

## Check everything

| Tool | Command | What you should see |
|---|---|---|
| Git | `git --version` | A version number |
| Node.js | `node --version` | v20 or higher |
| npm | `npm --version` | A version number |
| Kubo | `ipfs --version` | `ipfs version 0.43.1` or newer |
| FFmpeg | `ffprobe -version` | A version banner |
| WSL | `wsl -l -v` | Ubuntu, with VERSION 2 |
| Docker | `docker run hello-world` in Ubuntu | "Hello from Docker!" |
| jq | `jq --version` in Ubuntu | A version number |

## Versions the author used

| Program | Version |
|---|---|
| Windows | 11 Pro, build 26100 |
| WSL | 3.0.1.0, with Ubuntu |
| Docker | 29.8.2 |
| Hyperledger Fabric | 2.5.16 (downloaded by the setup guide) |
| Kubo | 0.43.1 |
| Node.js | 24.18.0 on Windows |

Newer versions will usually work. If something fails, install the versions above first.

## Next

Go to `docs/SETUP.md`.
