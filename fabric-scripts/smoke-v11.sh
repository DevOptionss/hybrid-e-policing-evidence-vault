#!/usr/bin/env bash
# Smoke test for chaincode version 1.1 on the live Fabric network.
# Checks the custody chain, manifests, device batches and the role refusals.
set -uo pipefail

NET="$HOME/fabric/fabric-samples/test-network"
export PATH="$NET/../bin:$PATH"
export FABRIC_CFG_PATH="$NET/../config/"
export CORE_PEER_TLS_ENABLED=true
ORDERER_CA="$NET/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORG1_TLS="$NET/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem"
ORG2_TLS="$NET/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem"
CH=mychannel
CC=evidence
PASS=0; FAIL=0

as() {
  if [ "$1" = "1" ]; then
    export CORE_PEER_LOCALMSPID=Org1MSP CORE_PEER_TLS_ROOTCERT_FILE="$ORG1_TLS" CORE_PEER_ADDRESS=localhost:7051
  else
    export CORE_PEER_LOCALMSPID=Org2MSP CORE_PEER_TLS_ROOTCERT_FILE="$ORG2_TLS" CORE_PEER_ADDRESS=localhost:9051
  fi
  export CORE_PEER_MSPCONFIGPATH="$NET/organizations/peerOrganizations/org$1.example.com/users/$2@org$1.example.com/msp"
}
invoke() {
  local out
  out=$(peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
    -C "$CH" -n "$CC" --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_TLS" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_TLS" -c "$1" 2>&1)
  sleep 4
  echo "$out"
}
query() { peer chaincode query -C "$CH" -n "$CC" -c "$1" 2>&1; }
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
accepted() { echo "$1" | grep -q "Chaincode invoke successful"; }
reason() { echo "$1" | grep -o 'message:"[^"]*"' | head -1; }

as 1 Admin; ADMIN_ID=$(query '{"function":"WhoAmI","Args":[]}' | jq -r .id)
as 1 User1; INV_ID=$(query '{"function":"WhoAmI","Args":[]}' | jq -r .id)
if [ -z "$ADMIN_ID" ] || [ "$ADMIN_ID" = "null" ] || [ -z "$INV_ID" ]; then
  echo "Could not read identities. Is chaincode version 1.1 deployed and answering?"; exit 1
fi
HASH=$(openssl rand -hex 32); ROOT=$(openssl rand -hex 32); ROOT2=$(openssl rand -hex 32)
DEV="cam-$(date +%s)"

echo "== 1. Custody chain"
as 1 User1
out=$(invoke "$(jq -cn --arg h "$HASH" '{function:"RegisterEvidence",Args:["SMOKE-1","QmSmoke1",$h]}')")
accepted "$out" && ok "evidence registered" || bad "registration failed: $(reason "$out")"
ID=$(query '{"function":"GetEvidenceCount","Args":[]}' | jq -r .count)
out=$(invoke "$(jq -cn --arg id "$ID" --arg to "$ADMIN_ID" '{function:"TransferCustody",Args:[$id,$to]}')")
accepted "$out" && ok "custody handed over" || bad "handover failed: $(reason "$out")"
trail=$(query "$(jq -cn --arg id "$ID" '{function:"GetCustodyTrail",Args:[$id]}')")
[ "$(echo "$trail" | jq -r .valid)" = "true" ] && [ "$(echo "$trail" | jq -r .count)" = "2" ] \
  && ok "custody trail has 2 linked entries and is valid" || bad "custody trail unexpected: $trail"

echo "== 2. Manifest for CCTV footage"
as 1 User1
out=$(invoke "$(jq -cn --arg r "$ROOT" --arg h "$HASH" '{function:"MediaContract:RegisterManifest",Args:["SMOKE-2","cctv","QmManifest",$r,$h,"25","1700000000000","1700000250000"]}')")
accepted "$out" && ok "manifest registered" || bad "manifest failed: $(reason "$out")"
MID=$(query '{"function":"GetEvidenceCount","Args":[]}' | jq -r .count)
m=$(query "$(jq -cn --arg id "$MID" '{function:"MediaContract:GetManifest",Args:[$id]}')")
[ "$(echo "$m" | jq -r .media.segmentCount)" = "25" ] && ok "manifest read back with 25 segments" || bad "manifest read failed: $m"
as 2 Admin
out=$(invoke "$(jq -cn --arg r "$ROOT" --arg h "$HASH" '{function:"MediaContract:RegisterManifest",Args:["SMOKE-3","cctv","QmX",$r,$h,"1","1","2"]}')")
accepted "$out" && bad "verifier was allowed to register a manifest" || ok "verifier refused: $(reason "$out")"

echo "== 3. IoT batches"
as 1 Admin
out=$(invoke "$(jq -cn --arg d "$DEV" --arg g "$INV_ID" '{function:"MediaContract:RegisterDevice",Args:[$d,$g]}')")
accepted "$out" && ok "device $DEV registered" || bad "device registration failed: $(reason "$out")"
as 1 User1
out=$(invoke "$(jq -cn --arg d "$DEV" --arg r "$ROOT" '{function:"MediaContract:AnchorBatch",Args:[$d,"1",$r,"500","QmB1"]}')")
accepted "$out" && ok "batch 1 anchored" || bad "batch 1 failed: $(reason "$out")"
out=$(invoke "$(jq -cn --arg d "$DEV" --arg r "$ROOT2" '{function:"MediaContract:AnchorBatch",Args:[$d,"3",$r,"500","QmB3"]}')")
accepted "$out" && bad "a gap in the batch index was accepted" || ok "gap refused: $(reason "$out")"
out=$(invoke "$(jq -cn --arg d "$DEV" --arg r "$ROOT" '{function:"MediaContract:AnchorBatch",Args:[$d,"1",$r,"500","QmB1"]}')")
accepted "$out" && bad "a replayed batch was accepted" || ok "replay refused: $(reason "$out")"
as 2 User1
out=$(invoke "$(jq -cn --arg d "$DEV" --arg r "$ROOT2" '{function:"MediaContract:AnchorBatch",Args:[$d,"2",$r,"500","QmB2"]}')")
accepted "$out" && bad "the outsider anchored a batch" || ok "outsider refused: $(reason "$out")"
head=$(query "$(jq -cn --arg d "$DEV" '{function:"MediaContract:LastBatch",Args:[$d]}')")
[ "$(echo "$head" | jq -r .count)" = "1" ] && ok "batch head shows 1 anchored batch" || bad "unexpected batch head: $head"

echo
echo "$PASS passed, $FAIL failed."
[ "$FAIL" = "0" ]
