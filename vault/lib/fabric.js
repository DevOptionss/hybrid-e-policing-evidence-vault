'use strict';
/**
 * Fabric connection for the Evidence Vault.
 * Talks to the test network through the peers' published ports on localhost (7051 and 9051).
 * The identities are the test network's own users:
 *   officerA  Org1 Admin   administrator
 *   officerB  Org1 User1   investigator
 *   verifier  Org2 Admin   read only
 *   outsider  Org2 User1   no role
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');

const CHANNEL = process.env.FABRIC_CHANNEL || 'mychannel';
const CHAINCODE = process.env.FABRIC_CHAINCODE || 'evidence';

const ORGS = {
  1: { msp: 'Org1MSP', endpoint: 'localhost:7051', alias: 'peer0.org1.example.com' },
  2: { msp: 'Org2MSP', endpoint: 'localhost:9051', alias: 'peer0.org2.example.com' },
};

const ACCOUNTS = [
  { key: 'officerA', name: 'Investigator A (administrator)', org: 1, user: 'Admin' },
  { key: 'officerB', name: 'Investigator B', org: 1, user: 'User1' },
  { key: 'verifier', name: 'Verifier (read only)', org: 2, user: 'Admin' },
  { key: 'outsider', name: 'Outsider (not authorised)', org: 2, user: 'User1' },
];

function cryptoBase() {
  if (process.env.FABRIC_CRYPTO) return process.env.FABRIC_CRYPTO;
  if (process.platform === 'win32') {
    const distro = process.env.WSL_DISTRO || 'Ubuntu';
    const user = process.env.WSL_USER || 'ubuntu';
    return `\\\\wsl.localhost\\${distro}\\home\\${user}\\fabric\\fabric-samples\\test-network\\organizations`;
  }
  return path.join(os.homedir(), 'fabric', 'fabric-samples', 'test-network', 'organizations');
}

async function firstFile(dir) {
  const names = await fs.readdir(dir);
  if (!names.length) throw new Error('No files found in ' + dir);
  return path.join(dir, names[0]);
}

const decode = (bytes) => {
  const text = Buffer.from(bytes).toString('utf8');
  return text ? JSON.parse(text) : null;
};

/** Pull the chaincode's own message out of a gateway error. */
function describeError(e) {
  const parts = [];
  if (e && Array.isArray(e.details)) for (const d of e.details) if (d && d.message) parts.push(String(d.message));
  if (e && e.message) parts.push(String(e.message));
  if (e && e.cause && e.cause.message) parts.push(String(e.cause.message));
  const text = parts.join(' | ');
  let m = text.match(/chaincode response \d+, ([^|"\n]+)/);
  if (m) return m[1].trim();
  m = text.match(/message:"([^"]+)"/);
  if (m) return m[1].trim();
  return (text || String(e)).slice(0, 300);
}

function create() {
  const base = cryptoBase();
  const clients = new Map();
  const gateways = new Map();
  const events = [];
  const seen = new Set();
  let listening = false;
  let lastBlock = 0n;

  async function grpcClient(orgNo) {
    if (clients.has(orgNo)) return clients.get(orgNo);
    const org = ORGS[orgNo];
    const tlsPath = path.join(base, 'peerOrganizations', `org${orgNo}.example.com`, 'tlsca', `tlsca.org${orgNo}.example.com-cert.pem`);
    const tls = grpc.credentials.createSsl(await fs.readFile(tlsPath));
    const client = new grpc.Client(org.endpoint, tls, { 'grpc.ssl_target_name_override': org.alias });
    clients.set(orgNo, client);
    return client;
  }

  async function gateway(acct) {
    if (gateways.has(acct.key)) return gateways.get(acct.key);
    const orgDir = path.join(base, 'peerOrganizations', `org${acct.org}.example.com`, 'users', `${acct.user}@org${acct.org}.example.com`, 'msp');
    const credentials = await fs.readFile(await firstFile(path.join(orgDir, 'signcerts')));
    const privateKey = crypto.createPrivateKey(await fs.readFile(await firstFile(path.join(orgDir, 'keystore'))));
    const gw = connect({
      client: await grpcClient(acct.org),
      identity: { mspId: ORGS[acct.org].msp, credentials },
      signer: signers.newPrivateKeySigner(privateKey),
      hash: hash.sha256,
      evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
      endorseOptions: () => ({ deadline: Date.now() + 20000 }),
      submitOptions: () => ({ deadline: Date.now() + 10000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    gateways.set(acct.key, gw);
    return gw;
  }

  const find = (key) => {
    const a = ACCOUNTS.find((x) => x.key === key);
    if (!a) throw new Error('Unknown account');
    return a;
  };
  const contractFor = async (key, contractName) => (await gateway(find(key))).getNetwork(CHANNEL).getContract(CHAINCODE, contractName);
  const split = (fn) => (fn.includes(':') ? fn.split(':') : [undefined, fn]);

  async function listen() {
    if (listening) return;
    listening = true;
    (async () => {
      for (;;) {
        try {
          const network = (await gateway(ACCOUNTS[0])).getNetwork(CHANNEL);
          const iterable = await network.getChaincodeEvents(CHAINCODE, { startBlock: lastBlock });
          for await (const ev of iterable) {
            lastBlock = ev.blockNumber;
            const sig = ev.transactionId + ':' + ev.eventName;
            if (seen.has(sig)) continue;
            seen.add(sig);
            let payload = null;
            try { payload = decode(ev.payload); } catch (e) { /* ignore */ }
            events.push({ blockNumber: Number(ev.blockNumber), txId: ev.transactionId, name: ev.eventName, payload, time: 0 });
          }
        } catch (e) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
  }

  return {
    kind: 'fabric',
    channel: CHANNEL,
    chaincode: CHAINCODE,
    async init() { await listen(); },
    async accounts() {
      const out = [];
      for (const a of ACCOUNTS) {
        const w = decode(await (await contractFor(a.key)).evaluateTransaction('WhoAmI'));
        out.push({ key: a.key, name: a.name, id: w.id, mspId: w.mspId, role: w.role });
      }
      return out;
    },
    async height() { return events.length ? Math.max(...events.map((e) => e.blockNumber)) + 1 : 0; },
    async evaluate(acct, fn, ...args) {
      const [name, f] = split(fn);
      return decode(await (await contractFor(acct, name)).evaluateTransaction(f, ...args));
    },
    async submit(acct, fn, ...args) {
      const [name, f] = split(fn);
      const contract = await contractFor(acct, name);
      const proposal = contract.newProposal(f, { arguments: args });
      const transaction = await proposal.endorse();
      const commit = await transaction.submit();
      const status = await commit.getStatus();
      if (!status.successful) throw new Error(`Transaction ${status.transactionId} failed to commit with status code ${status.code}`);
      return { result: decode(transaction.getResult()), txId: status.transactionId, blockNumber: Number(status.blockNumber) };
    },
    events() { return events.slice(); },
    describeError,
  };
}

module.exports = { create };
