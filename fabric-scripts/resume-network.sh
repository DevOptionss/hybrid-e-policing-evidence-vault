#!/usr/bin/env bash
# Restarts the stopped Fabric containers after a reboot and keeps the ledger.
# Run it in Ubuntu (WSL) after Docker Desktop is running.
docker rm -f $(docker ps -aq --filter "name=dev-peer") 2>/dev/null || true
docker start orderer.example.com
sleep 3
docker start peer0.org1.example.com peer0.org2.example.com
sleep 5
docker ps --format 'table {{.Names}}\t{{.Status}}'
