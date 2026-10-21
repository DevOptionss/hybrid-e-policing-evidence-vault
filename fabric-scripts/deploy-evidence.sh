#!/usr/bin/env bash
# Deploys the evidence chaincode to the Fabric test network.
# Usage: ./deploy-evidence.sh [version]      (default 1.1, raise the number after any change to the chaincode)
set -euo pipefail
VERSION="${1:-1.1}"
NET="$HOME/fabric/fabric-samples/test-network"
CC_DIR="$HOME/fabric/evidence-cc"

if [ ! -f "$CC_DIR/package.json" ]; then
  echo "Chaincode folder not found at $CC_DIR"; exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q '^peer0.org1.example.com$'; then
  echo "The Fabric network is not running. Start it first:"
  echo "  cd $NET && ./network.sh up createChannel -c mychannel"
  exit 1
fi

cd "$NET"
./network.sh deployCC -ccn evidence -ccp "$CC_DIR" -ccl javascript -ccv "$VERSION"
echo
echo "Chaincode 'evidence' version $VERSION is deployed. Next: ~/fabric/scripts/setup-roles.sh"
