# vault

The Evidence Vault server, browser page and test scripts. Setup and usage are in the repository's [docs/SETUP.md](../docs/SETUP.md).

```
npm install
node server.js --demo     # in memory ledger, no Fabric needed
node server.js            # real Fabric network
```

Then open http://localhost:3000. Test scripts are in `tests/`, described in [docs/TESTING.md](../docs/TESTING.md). On Windows, `run-all.ps1` runs every test and measurement and saves each output in `evidence/`.
