#!/usr/bin/env bash
# Creates the four demonstration roles on the evidence chaincode.
#   Org1 Admin  -> administrator   (Investigator A)
#   Org1 User1  -> investigator    (Investigator B)
#   Org2 Admin  -> verifier        (read only, for example a prosecutor or laboratory)
#   Org2 User1  -> no role         (the outsider)
set -euo pipefail

NET="$HOME/fabric/fabric-samples/test-network"
export PATH="$NET/../bin:$PATH"
export FABRIC_CFG_PATH="$NET/../config/"
export CORE_PEER_TLS_ENABLED=true
ORDERER_CA="$NET/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORG1_TLS="$NET/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem"
ORG2_TLS="$NET/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem"
CH=mychannel
CC=evidence

# as <org number> <user>   switches the identity used by the peer commands
as() {
  if [ "$1" = "1" ]; then
    export CORE_PEER_LOCALMSPID=Org1MSP CORE_PEER_TLS_ROOTCERT_FILE="$ORG1_TLS" CORE_PEER_ADDRESS=localhost:7051
  else
    export CORE_PEER_LOCALMSPID=Org2MSP CORE_PEER_TLS_ROOTCERT_FILE="$ORG2_TLS" CORE_PEER_ADDRESS=localhost:9051
  fi
  export CORE_PEER_MSPCONFIGPATH="$NET/organizations/peerOrganizations/org$1.example.com/users/$2@org$1.example.com/msp"
}

invoke() {
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
    -C "$CH" -n "$CC" --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_TLS" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_TLS" -c "$1"
  sleep 4   # wait for the block to commit before the next call
}

whoami_json() {
  peer chaincode query -C "$CH" -n "$CC" -c '{"function":"WhoAmI","Args":[]}'
}

echo "== Initialising the ledger as the Org1 administrator"
as 1 Admin
invoke '{"function":"InitLedger","Args":[]}' || echo "(already initialised, continuing)"

echo "== Reading identity IDs"
as 1 User1; B_ID=$(whoami_json | jq -r .id)
as 2 Admin; V_ID=$(whoami_json | jq -r .id)

echo "== Granting roles"
as 1 Admin
invoke "$(jq -cn --arg id "$B_ID" '{function:"AddInvestigator",Args:[$id]}')"
invoke "$(jq -cn --arg id "$V_ID" '{function:"AddVerifier",Args:[$id]}')"

echo
echo "== Result"
for who in "1 Admin" "1 User1" "2 Admin" "2 User1"; do
  as $who
  printf '%-12s ' "Org$who"; whoami_json | jq -c '{mspId, role}'
done
