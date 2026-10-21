#!/usr/bin/env bash
# Writes ~/fabric/org1.env, a file of settings so that peer commands run as the Org1 administrator.
# Usage:  ./make-org1-env.sh && source ~/fabric/org1.env
cat > "$HOME/fabric/org1.env" <<'ENV'
export FABRIC_ROOT=$HOME/fabric/fabric-samples/test-network
export PATH=$FABRIC_ROOT/../bin:$PATH
export FABRIC_CFG_PATH=$FABRIC_ROOT/../config/
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=Org1MSP
export CORE_PEER_TLS_ROOTCERT_FILE=$FABRIC_ROOT/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem
export CORE_PEER_MSPCONFIGPATH=$FABRIC_ROOT/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051
export ORDERER_CA=$FABRIC_ROOT/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem
export ORG1_TLS=$FABRIC_ROOT/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem
export ORG2_TLS=$FABRIC_ROOT/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem
ENV
echo "Wrote $HOME/fabric/org1.env"
