import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeCashAddress, hexToBin } from "@bitauth/libauth";
import pusdBroadcastHandler from "../api/pusd/broadcast.mjs";
import pusdCircleVerifyHandler from "../api/pusd/circle/verify.mjs";
import pusdUnspentHandler from "../api/pusd/unspent.mjs";
import pusdSubmissionHandler from "../api/pusd/submission.mjs";
import transactionStatusHandler from "../api/transaction/status.mjs";
import {
  assertPreviousTransactionsAgree,
  parseMainnetElectrumProviderConfig,
  createUpstashMainnetRateLimiter,
  assertBchMainnetStateCommitment,
  createBchMainnetV3ContractContext,
  assertBchMainnetPayoutLayout,
  createPusdMainnetV3ContractContext,
  assertPusdMainnetCircleLayout,
  verifyPusdMainnetCircleTransaction,
  verifyBchMainnetCircleTransaction,
  assertPusdTokenOutputCarrier,
  assertPusdBchChangeCarrier,
  assertRequiredPusdSighash,
  assertUnspentSnapshotsAgree,
  cashAddressToLockingBytecode,
  hashBlockHeader,
  MAINNET_GENESIS,
  BCH_MAINNET_FORK_CHECKPOINT_HASH,
  BCH_MAINNET_FORK_CHECKPOINT_HEIGHT,
  BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH,
  BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT,
  assertBchMainnetChainIdentity,
  broadcastPusdTransactionOnce,
  createUpstashPusdBroadcastLedger,
  isPusdBroadcastLedgerConfigured,
  computeElectrumMerkleRoot,
  getVerifiedTransactionStatus,
  verifyElectrumMerkleProof,
  mainnetApiErrorStatus,
  lockingBytecodeToScriptHash,
  normalizeElectrumUnspent,
  MAINNET_BROADCAST_ENABLED,
  BCH_MAINNET_CIRCLE_BROADCAST_ENABLED,
  BCH_MAINNET_GATHER_BROADCAST_ENABLED,
  broadcastBchMainnetCircleTransaction,
  broadcastBchMainnetGatherTransaction,
  validateBchMainnetGatherLayout,
  createMainnetApiServer,
} from "./mainnet-api.mjs";

const mainnetP2pkh = "bitcoincash:qq2azmyyv6dtgczexyalqar70q036yund54qgw0wg6";
const testnetP2pkh = "bchtest:qq2azmyyv6dtgczexyalqar70q036yund53jvfde0x";
const txid = "ab".repeat(32);


function createMainnetTestAddress(seed) {
  const encoded = encodeCashAddress({
    prefix: "bitcoincash",
    type: "p2pkh",
    payload: new Uint8Array(20).fill(seed),
  });
  if (typeof encoded === "string") throw new Error(encoded);
  return encoded.address;
}


function createMainnetTestTokenAddress(seed) {
  const encoded = encodeCashAddress({
    prefix: "bitcoincash",
    type: "p2pkhWithTokens",
    payload: new Uint8Array(20).fill(seed),
  });
  if (typeof encoded === "string") throw new Error("Could not encode token-aware Mainnet test address");
  return encoded.address;
}

const pusdMainnetVerificationCircle = {
  version: 3,
  network: "mainnet",
  name: "PUSD verifier test circle",
  members: [createMainnetTestTokenAddress(31), createMainnetTestTokenAddress(32)],
  contribution: "200000",
  maxFee: "10000",
  stateCategory: "0123456789abcdef".repeat(4),
  initiator: createMainnetTestAddress(30),
  treasury: "bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q",
};

function pusdOutput(script, valueSatoshis, token) {
  return {
    lockingBytecode: hexToBin(script),
    valueSatoshis,
    ...(token ? { token } : {}),
  };
}

function pusdNft(context, commitment, capability = "none") {
  return {
    category: hexToBin(context.stateCategory),
    amount: 0n,
    nft: { capability, commitment: hexToBin(commitment) },
  };
}

function pusdToken(amount) {
  return { category: hexToBin("2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544"), amount };
}

function makePusdPayoutFixture(round = 1) {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  const feeScript = cashAddressToLockingBytecode(createMainnetTestAddress(33));
  const credit = Buffer.alloc(8);
  credit.writeBigUInt64LE(BigInt(context.contribution));
  const sourceOutputs = [
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "54" + round.toString(16).padStart(2, "0") + (round === 0 ? "00" : "01"), "minting")),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + credit.toString("hex"))),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5201" + credit.toString("hex"))),
    pusdOutput(context.escrowLockingBytecodes[0], 1_000n, pusdToken(context.contribution)),
    pusdOutput(context.escrowLockingBytecodes[1], 1_000n, pusdToken(context.contribution)),
    pusdOutput(feeScript, 60_000n),
  ];
  const inputScripts = [
    context.contractLockingBytecode,
    context.contractLockingBytecode,
    context.contractLockingBytecode,
    context.escrowLockingBytecodes[0],
    context.escrowLockingBytecodes[1],
    feeScript,
  ];
  return { context, feeScript, sourceOutputs, inputScripts };
}


const bchMainnetVerificationCircle = {
  version: 2,
  covenant: "fee-v3-auto-reserve-mainnet",
  network: "mainnet",
  name: "Preflight test circle",
  members: [createMainnetTestAddress(11), createMainnetTestAddress(12)],
  contribution: "200000",
  maxFee: "10000",
  stateCategory: "ab".repeat(32),
  initiator: createMainnetTestAddress(11),
  treasury: "bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q",
};


test("Upstash Mainnet rate limit is atomic across independent serverless instances", async () => {
  const store = new Map();
  let now = 1_800_000_000_000;
  const fetchImpl = async (_url, init) => {
    const [command, script, numberOfKeys, key, ttl] = JSON.parse(init.body);
    assert.equal(command, "EVAL");
    assert.equal(numberOfKeys, "1");
    assert.match(script, /INCR/);
    assert.match(script, /PEXPIRE/);
    assert.equal(ttl, "65000");
    const count = (store.get(key) ?? 0) + 1;
    store.set(key, count);
    return { ok: true, status: 200, json: async () => ({ result: count }) };
  };
  const firstInstance = createUpstashMainnetRateLimiter({
    url: "https://redis.example.test",
    token: "private-test-token",
    fetchImpl,
    now: () => now,
    maxRequests: 2,
    windowMs: 60_000,
    useForwardedIp: true,
  });
  const secondInstance = createUpstashMainnetRateLimiter({
    url: "https://redis.example.test",
    token: "private-test-token",
    fetchImpl,
    now: () => now,
    maxRequests: 2,
    windowMs: 60_000,
    useForwardedIp: true,
  });
  const clientA = { headers: { "x-vercel-forwarded-for": "203.0.113.10" }, socket: {} };
  const clientB = { headers: { "x-vercel-forwarded-for": "203.0.113.11" }, socket: {} };
  assert.equal((await firstInstance.consume(clientA)).remaining, 1);
  assert.equal((await secondInstance.consume(clientA)).remaining, 0);
  await assert.rejects(firstInstance.consume(clientA), /Rate limit exceeded/i);
  assert.equal((await secondInstance.consume(clientB)).count, 1);
  now += 60_000;
  assert.equal((await firstInstance.consume(clientA)).count, 1);
  const keys = [...store.keys()];
  assert.ok(keys.every((item) => item.startsWith("ajochain:{mainnet-spend}:rate:v1:")));
  assert.ok(keys.every((item) => !item.includes("203.0.113.")));
});

test("Upstash Mainnet rate limiter fails closed for invalid IP, absent credentials and storage outage", async () => {
  assert.throws(() => createUpstashMainnetRateLimiter({
    url: "", token: "", fetchImpl: async () => ({}),
  }), /not configured/i);
  const invalidIp = createUpstashMainnetRateLimiter({
    url: "https://redis.example.test", token: "private-test-token",
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: 1 }) }),
    useForwardedIp: true,
  });
  await assert.rejects(invalidIp.consume({ headers: { "x-vercel-forwarded-for": "spoofed" }, socket: {} }), /valid client IP/i);
  const outage = createUpstashMainnetRateLimiter({
    url: "https://redis.example.test", token: "private-test-token",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  await assert.rejects(outage.consume({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), /rate limiter is unavailable/i);
});

test("Mainnet Electrum provider manifest requires unique operator identities", () => {
  const providers = parseMainnetElectrumProviderConfig(
    "wss://node-a.example:50004,wss://node-b.example:50004",
    "provider-a,provider-b",
  );
  assert.deepEqual(providers, [
    { endpoint: "wss://node-a.example:50004", operatorId: "provider-a" },
    { endpoint: "wss://node-b.example:50004", operatorId: "provider-b" },
  ]);
  assert.throws(() => parseMainnetElectrumProviderConfig(
    "wss://node-a.example:50004,wss://node-b.example:50004",
    "",
  ), /exactly one operator ID per/i);
  assert.throws(() => parseMainnetElectrumProviderConfig(
    "wss://node-a.example:50004,wss://node-b.example:50004",
    "same-operator,same-operator",
  ), /distinct operator IDs/i);
  assert.throws(() => parseMainnetElectrumProviderConfig(
    "wss://node-a.example:50004,wss://node-a.example:50005",
    "provider-a,provider-b",
  ), /different hostnames/i);
  assert.throws(() => parseMainnetElectrumProviderConfig(
    "ws://node-a.example:50004,wss://node-b.example:50004",
    "provider-a,provider-b",
  ), /secure wss/i);
  assert.throws(() => parseMainnetElectrumProviderConfig(
    "wss://user:password@node-a.example:50004,wss://node-b.example:50004",
    "provider-a,provider-b",
  ), /without embedded credentials/i);
});

test("Mainnet BCH gather accepts only one token-free output back to a wallet-derived address", () => {
  const walletAddress = createMainnetTestAddress(21);
  const otherAddress = createMainnetTestAddress(22);
  const walletScript = cashAddressToLockingBytecode(walletAddress);
  const otherScript = cashAddressToLockingBytecode(otherAddress);
  const inputHash = Buffer.from("0123456789abcdef".repeat(4), "hex");
  const input = {
    outpointTransactionHash: inputHash,
    outpointIndex: 1,
    unlockingBytecode: Buffer.from([0x01, 0x01]),
  };
  const makeTransaction = (output) => ({ inputs: [input], outputs: [output] });
  const walletOutput = {
    valueSatoshis: 50_000n,
    lockingBytecode: Buffer.from(walletScript, "hex"),
  };
  const layout = validateBchMainnetGatherLayout(
    makeTransaction(walletOutput),
    [walletScript],
    walletScript,
    180,
  );
  assert.equal(layout.outputSatoshis, 50_000n);
  assert.deepEqual(layout.inputOutpoints, [Buffer.from(inputHash).reverse().toString("hex") + ":1"]);

  assert.throws(() => validateBchMainnetGatherLayout(
    makeTransaction({ ...walletOutput, lockingBytecode: Buffer.from(otherScript, "hex") }),
    [walletScript],
    walletScript,
    180,
  ), /return all BCH to the selected wallet address/i);
  assert.throws(() => validateBchMainnetGatherLayout(
    makeTransaction({ ...walletOutput, token: { category: "cd".repeat(32), amount: 1n } }),
    [walletScript],
    walletScript,
    180,
  ), /without CashTokens/i);
  assert.throws(() => validateBchMainnetGatherLayout(
    { inputs: [input], outputs: [walletOutput, walletOutput] },
    [walletScript],
    walletScript,
    220,
  ), /exactly one consolidation output/i);
  assert.throws(() => validateBchMainnetGatherLayout(
    makeTransaction(walletOutput),
    [walletScript],
    otherScript,
    180,
  ), /wallet's derived P2PKH addresses/i);
});

test("Mainnet BCH gather has a separate explicit broadcast gate", async () => {
  assert.equal(BCH_MAINNET_GATHER_BROADCAST_ENABLED, true);
  await assert.rejects(
    broadcastBchMainnetGatherTransaction([], {}, {}, false),
    /wallet gathering is disabled/i,
  );
});

test("BCH Mainnet V3 verifier parses exact three-byte state NFT commitments", () => {
  const outputFor = (commitment) => ({
    token: { nft: { commitment: Buffer.from(commitment, "hex") } },
  });
  assert.doesNotThrow(() => assertBchMainnetStateCommitment(outputFor("540000"), 0, 0, "genesis state"));
  assert.doesNotThrow(() => assertBchMainnetStateCommitment(outputFor("540101"), 1, 1, "round two state"));
  assert.doesNotThrow(() => assertBchMainnetStateCommitment(outputFor("540401"), 4, 1, "last payout state"));
  assert.doesNotThrow(() => assertBchMainnetStateCommitment(outputFor("540501"), 5, 1, "terminal state"));
  assert.throws(() => assertBchMainnetStateCommitment(outputFor("540500"), 5, 1, "bad terminal state"), /expected V3 round and payout marker/i);
  assert.throws(() => assertBchMainnetStateCommitment(outputFor("540600"), 6, 0, "out-of-range state"), /expected V3 round and payout marker/i);
  assert.throws(() => assertBchMainnetStateCommitment(outputFor("5401"), 1, 0, "truncated state"), /expected V3 round and payout marker/i);
});

test("BCH Mainnet server derives the exact V3 covenant script from immutable constructor bindings", () => {
  const context = createBchMainnetV3ContractContext(bchMainnetVerificationCircle);
  assert.match(context.contractLockingBytecode, /^aa20[0-9a-f]{64}87$/);
  assert.equal(cashAddressToLockingBytecode(context.contractAddress), context.contractLockingBytecode);
  assert.equal(context.memberCount, 2);
  assert.equal(context.treasuryScript, "76a91417c8d3de33e0e229101f756dc5f189b123c1c83c88ac");
});

test("BCH Mainnet server rejects unsafe or altered covenant constructor contexts", () => {
  assert.throws(() => createBchMainnetV3ContractContext({
    ...bchMainnetVerificationCircle,
    network: "chipnet",
  }), /valid BCH Mainnet V3 circle context/i);
  assert.throws(() => createBchMainnetV3ContractContext({
    ...bchMainnetVerificationCircle,
    covenant: "fee-v3-auto-reserve",
  }), /valid BCH Mainnet V3 circle context/i);
  assert.throws(() => createBchMainnetV3ContractContext({
    ...bchMainnetVerificationCircle,
    treasury: createMainnetTestAddress(99),
  }), /immutable AjoChain treasury/i);
  assert.throws(() => createBchMainnetV3ContractContext({
    ...bchMainnetVerificationCircle,
    members: [createMainnetTestAddress(11), createMainnetTestAddress(11)],
  }), /must be unique/i);
  assert.throws(() => createBchMainnetV3ContractContext({
    ...bchMainnetVerificationCircle,
    members: [testnetP2pkh, createMainnetTestAddress(12)],
  }), /only Bitcoin Cash mainnet/i);
  assert.throws(() => createBchMainnetV3ContractContext({
    ...bchMainnetVerificationCircle,
    stateCategory: "not-a-token-category",
  }), /valid BCH Mainnet V3 circle context/i);
});

test("BCH Mainnet verifier rejects unknown operations before network access", async () => {
  await assert.rejects(
    verifyBchMainnetCircleTransaction([], { height: 900_000, hash: "00".repeat(32) }, {
      operation: "broadcast",
    }),
    /Unsupported BCH Mainnet circle verification operation/i,
  );
});

test("CashAddress decoding creates the correct mainnet P2PKH script", () => {
  assert.equal(
    cashAddressToLockingBytecode(mainnetP2pkh),
    "76a91415d16c84669ab46059313bf0747e781f1d13936d88ac",
  );
});

test("CashAddress decoding accepts token-aware P2PKH addresses", () => {
  assert.equal(
    cashAddressToLockingBytecode("bitcoincash:zq2azmyyv6dtgczexyalqar70q036yund5j2mspghf"),
    "76a91415d16c84669ab46059313bf0747e781f1d13936d88ac",
  );
});

test("CashAddress decoding rejects Chipnet and malformed addresses", () => {
  assert.throws(() => cashAddressToLockingBytecode(testnetP2pkh), /only Bitcoin Cash mainnet/i);
  assert.throws(() => cashAddressToLockingBytecode("not-an-address"), /Invalid CashAddress/);
});

test("Electrum UTXOs normalize to exact decimal satoshi strings", () => {
  assert.deepEqual(normalizeElectrumUnspent([{
    tx_hash: txid,
    tx_pos: 3,
    height: 900_000,
    value: 123_456,
  }]), [{
    txid,
    vout: 3,
    height: 900_000,
    satoshis: "123456",
  }]);
});

test("Electrum UTXO normalization rejects bad heights and duplicate outpoints", () => {
  assert.throws(() => normalizeElectrumUnspent([{
    tx_hash: txid, tx_pos: 0, height: -1, value: 1000,
  }]), /malformed/);
  assert.throws(() => normalizeElectrumUnspent([
    { tx_hash: txid, tx_pos: 0, height: 10, value: 1000 },
    { tx_hash: txid, tx_pos: 0, height: 10, value: 1000 },
  ]), /duplicate/);
});

test("Electrum quorum rejects differing UTXO sets", () => {
  const first = [{ txid, vout: 0, height: 1, satoshis: "1000" }];
  const second = [{ txid, vout: 1, height: 1, satoshis: "1000" }];
  assert.throws(() => assertUnspentSnapshotsAgree([first, second]), /disagree/);
  assert.deepEqual(assertUnspentSnapshotsAgree([first, first]), first);
});

test("Electrum script hash uses SHA256 digest in reversed byte order", () => {
  const script = "76a914" + "11".repeat(20) + "88ac";
  const digest = createHash("sha256").update(Buffer.from(script, "hex")).digest();
  const expected = Buffer.from(digest).reverse().toString("hex");
  assert.equal(lockingBytecodeToScriptHash(script), expected);
  assert.throws(() => lockingBytecodeToScriptHash(""), /non-empty/);
});

test("server Mainnet quorum distinguishes BCH from BTC and BSV using both fork checkpoints", () => {
  const valid = {
    height: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT + 100,
    genesisHash: MAINNET_GENESIS,
    forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH,
    postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH,
  };
  assert.doesNotThrow(() => assertBchMainnetChainIdentity(valid));
  assert.throws(() => assertBchMainnetChainIdentity({
    ...valid, forkCheckpointHash: "00".repeat(32),
  }), /2017 BCH\/BTC split/);
  assert.throws(() => assertBchMainnetChainIdentity({
    ...valid, postBsvForkCheckpointHash: "00".repeat(32),
  }), /2018 BCH\/BSV split/);
  assert.throws(() => assertBchMainnetChainIdentity({
    ...valid, height: BCH_MAINNET_FORK_CHECKPOINT_HEIGHT - 1,
  }), /predates the BCH\/BTC chain-identity checkpoint/);
  assert.throws(() => assertBchMainnetChainIdentity({
    ...valid, height: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT - 1,
  }), /predates the BCH\/BSV chain-identity checkpoint/);
});

test("BCH genesis header is recognized by its canonical mainnet hash", () => {
  const genesisHeader =
    "01000000" +
    "00".repeat(32) +
    "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" +
    "29ab5f49" +
    "ffff001d" +
    "1dac2b7c";
  assert.equal(
    hashBlockHeader(genesisHeader),
    "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  );
  assert.throws(() => hashBlockHeader("00"), /malformed/);
});


test("PUSD Mainnet broadcast stays locked even if a runtime override is set", async () => {
  const original = process.env.ENABLE_MAINNET_BROADCAST;
  process.env.ENABLE_MAINNET_BROADCAST = "true";
  const server = createMainnetApiServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch("http://127.0.0.1:" + address.port + "/api/pusd/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(MAINNET_BROADCAST_ENABLED, false);
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.match(payload.error, /Mainnet broadcast is disabled/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (original === undefined) delete process.env.ENABLE_MAINNET_BROADCAST;
    else process.env.ENABLE_MAINNET_BROADCAST = original;
  }
});

test("PUSD token outputs must meet the serialized CashTokens dust threshold", () => {
  const output = {
    valueSatoshis: 500n,
    lockingBytecode: Buffer.from("76a914" + "11".repeat(20) + "88ac", "hex"),
    token: {
      category: Buffer.from("2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544", "hex"),
      amount: 100n,
    },
  };
  assert.throws(() => assertPusdTokenOutputCarrier(output, 0), /below the serialized-output dust threshold/);
  assert.doesNotThrow(() => assertPusdTokenOutputCarrier({ ...output, valueSatoshis: 1000n }, 0));
});

test("PUSD server requires the wallet's 0x61 P2PKH sighash", () => {
  const signature = Buffer.from([0x30, 0x01, 0x01, 0x61]);
  const publicKey = Buffer.alloc(33, 2);
  const script = Buffer.concat([
    Buffer.from([signature.length]), signature,
    Buffer.from([publicKey.length]), publicKey,
  ]);
  assert.doesNotThrow(() => assertRequiredPusdSighash(script, 0));

  const weakSignature = Buffer.from([0x30, 0x01, 0x01, 0x41]);
  const weakScript = Buffer.concat([
    Buffer.from([weakSignature.length]), weakSignature,
    Buffer.from([publicKey.length]), publicKey,
  ]);
  assert.throws(() => assertRequiredPusdSighash(weakScript, 1), /0x61/);
  assert.throws(() => assertRequiredPusdSighash(Buffer.from([0x51]), 2), /non-push unlocking opcode/);
});

test("PUSD server rejects dust-sized BCH change outputs", () => {
  const output = {
    valueSatoshis: 500n,
    lockingBytecode: Buffer.from("76a914" + "11".repeat(20) + "88ac", "hex"),
  };
  assert.throws(() => assertPusdBchChangeCarrier(output, 0), /BCH change output 0 is below/);
  assert.doesNotThrow(() => assertPusdBchChangeCarrier({ ...output, valueSatoshis: 1000n }, 0));
});

test("raw previous transaction bytes must agree across the Electrum quorum", () => {
  const raw = "01000000" + "00".repeat(10);
  assert.equal(assertPreviousTransactionsAgree([{ hex: raw }, { hex: raw.toUpperCase() }]), raw);
  assert.throws(() => assertPreviousTransactionsAgree([{ hex: raw }, { hex: "02000000" + "00".repeat(10) }]), /disagree/);
  assert.throws(() => assertPreviousTransactionsAgree([{ hex: raw }]), /at least two/i);
  assert.throws(() => assertPreviousTransactionsAgree([{ hex: "not-hex" }, { hex: raw }]), /malformed/);
});


function sampleRawTransactionHex() {
  return "01000000" +
    "01" + "11".repeat(32) +
    "00000000" + "00" + "ffffffff" +
    "01" + "e803000000000000" +
    "01" + "51" + "00000000";
}

function transactionIdFromHex(hex) {
  const first = createHash("sha256").update(Buffer.from(hex, "hex")).digest();
  const second = createHash("sha256").update(first).digest();
  return Buffer.from(second).reverse().toString("hex");
}

test("PUSD health readiness reports the private durable ledger configuration explicitly", () => {
  assert.equal(isPusdBroadcastLedgerConfigured({}), false);
  assert.equal(isPusdBroadcastLedgerConfigured({
    UPSTASH_REDIS_REST_URL: "http://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "private-token",
  }), false);
  assert.equal(isPusdBroadcastLedgerConfigured({
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "private-token",
  }), true);
  assert.equal(isPusdBroadcastLedgerConfigured({
    UPSTASH_REDIS_REST_URL: "https://user:pass@redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "private-token",
  }), false);
});

test("Upstash PUSD ledger reserves one exact transaction across concurrent requests and records accepted state", async () => {
  const store = new Map();
  const commands = [];
  const fetchImpl = async (_url, init) => {
    const args = JSON.parse(init.body);
    commands.push(args);
    const [name, ...rest] = args;
    if (name === "MSETNX") {
      const pairs = [];
      for (let index = 0; index < rest.length; index += 2) pairs.push([rest[index], rest[index + 1]]);
      if (pairs.some(([key]) => store.has(key))) return { ok: true, status: 200, json: async () => ({ result: 0 }) };
      for (const [key, value] of pairs) store.set(key, value);
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    if (name === "MGET") return { ok: true, status: 200, json: async () => ({ result: rest.map((key) => store.get(key) ?? null) }) };
    if (name === "SET") {
      const [key, value, condition] = rest;
      if (condition === "NX" && store.has(key)) return { ok: true, status: 200, json: async () => ({ result: null }) };
      if (condition === "XX" && !store.has(key)) return { ok: true, status: 200, json: async () => ({ result: null }) };
      store.set(key, value);
      return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
    }
    if (name === "GET") {
      const [key] = rest;
      return { ok: true, status: 200, json: async () => ({ result: store.get(key) ?? null }) };
    }
    throw new Error("Unexpected Redis REST command: " + name);
  };
  const ledger = createUpstashPusdBroadcastLedger({
    url: "https://redis.example.test",
    token: "private-test-token",
    fetchImpl,
  });
  const signed = sampleRawTransactionHex();
  const txid = transactionIdFromHex(signed);

  const reservations = await Promise.all([
    ledger.reserve(txid, signed),
    ledger.reserve(txid, signed),
  ]);
  assert.equal(reservations.filter((result) => result.acquired).length, 1);
  assert.equal(reservations.filter((result) => !result.acquired).length, 1);
  const first = reservations.find((result) => result.acquired);
  const duplicate = reservations.find((result) => !result.acquired);
  assert.ok(first);
  assert.ok(duplicate);
  assert.equal(first.record.status, "submitting");
  assert.equal(duplicate.record.status, "submitting");

  const accepted = await ledger.complete(txid, signed, "accepted");
  assert.equal(accepted.status, "accepted");

  const replay = await ledger.reserve(txid, signed);
  assert.equal(replay.acquired, false);
  assert.equal(replay.record.status, "accepted");
  assert.equal((await ledger.get(txid)).relayStatus, "accepted");

  assert.ok(commands.some((args) => args[0] === "MSETNX"));
  assert.ok(commands.some((args) => args[0] === "MGET"));
  assert.ok(commands.some((args) => args[0] === "SET" && args.includes("XX")));
});

test("Upstash Mainnet input locks reject a different transaction spending the same outpoint", async () => {
  const store = new Map();
  const fetchImpl = async (_url, init) => {
    const [name, ...rest] = JSON.parse(init.body);
    if (name === "MSETNX") {
      const pairs = [];
      for (let index = 0; index < rest.length; index += 2) pairs.push([rest[index], rest[index + 1]]);
      if (pairs.some(([key]) => store.has(key))) return { ok: true, status: 200, json: async () => ({ result: 0 }) };
      for (const [key, value] of pairs) store.set(key, value);
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    if (name === "MGET") return { ok: true, status: 200, json: async () => ({ result: rest.map((key) => store.get(key) ?? null) }) };
    if (name === "GET") return { ok: true, status: 200, json: async () => ({ result: store.get(rest[0]) ?? null }) };
    if (name === "SET") {
      const [key, value, condition] = rest;
      if (condition === "XX" && !store.has(key)) return { ok: true, status: 200, json: async () => ({ result: null }) };
      store.set(key, value);
      return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
    }
    throw new Error("Unexpected Redis REST command: " + name);
  };
  const ledger = createUpstashPusdBroadcastLedger({
    url: "https://redis.example.test",
    token: "private-test-token",
    fetchImpl,
  });
  const original = sampleRawTransactionHex();
  const conflicting = original.replace("e803000000000000", "d007000000000000");
  const originalTxid = transactionIdFromHex(original);
  const conflictingTxid = transactionIdFromHex(conflicting);
  assert.notEqual(conflictingTxid, originalTxid);

  assert.equal((await ledger.reserve(originalTxid, original)).acquired, true);
  await assert.rejects(
    ledger.reserve(conflictingTxid, conflicting),
    /input outpoint .*already reserved by a different transaction/i,
  );
  assert.equal((await ledger.get(originalTxid)).status, "submitting");
  assert.equal(await ledger.get(conflictingTxid), null);
});

test("Upstash PUSD ledger preserves unknown submissions and fails closed when storage is unavailable", async () => {
  const store = new Map();
  const ledger = createUpstashPusdBroadcastLedger({
    url: "https://redis.example.test",
    token: "private-test-token",
    fetchImpl: async (_url, init) => {
      const [name, ...rest] = JSON.parse(init.body);
      if (name === "MSETNX") {
        const pairs = [];
        for (let index = 0; index < rest.length; index += 2) pairs.push([rest[index], rest[index + 1]]);
        if (pairs.some(([key]) => store.has(key))) return { ok: true, status: 200, json: async () => ({ result: 0 }) };
        for (const [key, value] of pairs) store.set(key, value);
        return { ok: true, status: 200, json: async () => ({ result: 1 }) };
      }
      if (name === "MGET") return { ok: true, status: 200, json: async () => ({ result: rest.map((key) => store.get(key) ?? null) }) };
      if (name === "SET") {
        const [key, value, condition] = rest;
        if (condition === "NX" && store.has(key)) return { ok: true, status: 200, json: async () => ({ result: null }) };
        if (condition === "XX" && !store.has(key)) return { ok: true, status: 200, json: async () => ({ result: null }) };
        store.set(key, value);
        return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
      }
      if (name === "GET") {
        const [key] = rest;
        return { ok: true, status: 200, json: async () => ({ result: store.get(key) ?? null }) };
      }
      throw new Error("Unexpected Redis REST command");
    },
  });
  const signed = sampleRawTransactionHex();
  const txid = transactionIdFromHex(signed);
  await ledger.reserve(txid, signed);
  await ledger.complete(txid, signed, "unknown");
  const retry = await ledger.reserve(txid, signed);
  assert.equal(retry.acquired, false);
  assert.equal(retry.record.status, "unknown");

  assert.throws(() => createUpstashPusdBroadcastLedger({
    url: "http://redis.example.test",
    token: "private-test-token",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: "OK" }) }),
  }), /HTTPS/);
  assert.throws(() => createUpstashPusdBroadcastLedger({
    url: "",
    token: "",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: "OK" }) }),
  }), /not configured/);
  assert.equal(mainnetApiErrorStatus("PUSD durable broadcast ledger is unavailable"), 503);
  assert.equal(mainnetApiErrorStatus("Mainnet input outpoint ab:0 is already reserved by a different transaction"), 409);

  const unavailable = createUpstashPusdBroadcastLedger({
    url: "https://redis.example.test",
    token: "private-test-token",
    fetchImpl: async () => { throw new Error("simulated network outage"); },
  });
  await assert.rejects(unavailable.reserve(txid, signed), /ledger is unavailable/);
});

test("PUSD broadcaster uses one relay and reports the provider's exact txid", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const calls = [];
  const sessions = [
    { call: async (method, params) => {
      calls.push([0, method, params]);
      if (method === "blockchain.transaction.broadcast") return txid;
      throw new Error("unexpected lookup");
    } },
    { call: async (method, params) => {
      calls.push([1, method, params]);
      throw new Error("unexpected second-provider call");
    } },
  ];

  const result = await broadcastPusdTransactionOnce(sessions, raw, txid);
  assert.deepEqual(result, { txid, relayStatus: "accepted" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "blockchain.transaction.broadcast");
});

test("PUSD broadcaster resolves a lost relay response by finding the exact tx on a provider", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const calls = [];
  const sessions = [
    { call: async (method, params) => {
      calls.push([0, method]);
      if (method === "blockchain.transaction.broadcast") throw new Error("socket timed out");
      if (method === "blockchain.transaction.get") throw new Error("not found here");
      throw new Error("unexpected method");
    } },
    { call: async (method, params) => {
      calls.push([1, method]);
      if (method === "blockchain.transaction.get") return raw;
      throw new Error("second provider must never receive a broadcast");
    } },
  ];

  const result = await broadcastPusdTransactionOnce(sessions, raw, txid);
  assert.deepEqual(result, { txid, relayStatus: "already-known" });
  assert.deepEqual(calls.map((call) => call[1]), [
    "blockchain.transaction.broadcast",
    "blockchain.transaction.get",
    "blockchain.transaction.get",
  ]);
});

test("PUSD broadcaster never retries when a relay result remains unknown", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const calls = [];
  const sessions = [
    { call: async (method) => {
      calls.push([0, method]);
      if (method === "blockchain.transaction.broadcast") throw new Error("socket timed out");
      throw new Error("transaction not found");
    } },
    { call: async (method) => {
      calls.push([1, method]);
      throw new Error("transaction not found");
    } },
  ];

  await assert.rejects(
    broadcastPusdTransactionOnce(sessions, raw, txid),
    /result is UNKNOWN.*It was not retried/s,
  );
  assert.equal(calls.filter((call) => call[1] === "blockchain.transaction.broadcast").length, 1);
  assert.equal(calls.some((call) => call[0] === 1 && call[1] === "blockchain.transaction.broadcast"), false);
});

test("PUSD broadcaster rejects a transaction ID that does not match the signed bytes", async () => {
  const raw = sampleRawTransactionHex();
  let called = false;
  const sessions = [
    { call: async () => { called = true; throw new Error("must not be called"); } },
    { call: async () => { called = true; throw new Error("must not be called"); } },
  ];
  await assert.rejects(
    broadcastPusdTransactionOnce(sessions, raw, "ab".repeat(32)),
    /does not match the exact signed transaction bytes/,
  );
  assert.equal(called, false);
});


test("transaction-status endpoint rejects malformed txids before opening Electrum sessions", async () => {
  const server = createMainnetApiServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      "http://127.0.0.1:" + address.port + "/api/transaction/status?txid=not-a-txid",
    );
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /exactly 64 hexadecimal characters/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ambiguous PUSD relay outcomes are exposed as retry-blocked service errors", () => {
  assert.equal(
    mainnetApiErrorStatus("PUSD broadcast result is UNKNOWN for " + "ab".repeat(32) + ". It was not retried."),
    503,
  );
  assert.equal(mainnetApiErrorStatus("Rate limit exceeded; retry in one minute."), 429);
  assert.equal(mainnetApiErrorStatus("Request body exceeds the permitted size."), 413);
  assert.equal(mainnetApiErrorStatus("Invalid PUSD amount."), 400);
});


function headerWithMerkleRoot(rootHex) {
  const header = Buffer.alloc(80);
  header.writeUInt32LE(1, 0);
  Buffer.from(rootHex, "hex").reverse().copy(header, 36);
  header.writeUInt32LE(1_800_000_000, 68);
  return header.toString("hex");
}

function makeStatusSession({ raw, proof, header, proofError, transactionError } = {}) {
  return {
    call: async (method) => {
      if (method === "blockchain.transaction.get") {
        if (transactionError) throw new Error(transactionError);
        return raw;
      }
      if (method === "blockchain.transaction.get_merkle") {
        if (proofError) throw new Error(proofError);
        return proof;
      }
      if (method === "blockchain.block.header") return header;
      throw new Error("Unexpected Electrum method: " + method);
    },
  };
}

test("Electrum merkle proof verifies the leaf hash against the serialized block-header root", () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const proof = { block_height: 900_000, merkle: [], pos: 0 };
  const header = headerWithMerkleRoot(txid);

  assert.equal(computeElectrumMerkleRoot(txid, [], 0), txid);
  assert.equal(verifyElectrumMerkleProof(txid, proof, header), true);
  assert.equal(verifyElectrumMerkleProof(txid, proof, headerWithMerkleRoot("ab".repeat(32))), false);
});

test("Electrum merkle proof respects sibling order and position bits", () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const sibling = "42".repeat(32);
  const left = Buffer.from(sibling, "hex").reverse();
  const right = Buffer.from(txid, "hex").reverse();
  const first = createHash("sha256").update(Buffer.concat([left, right])).digest();
  const second = createHash("sha256").update(first).digest();
  const root = Buffer.from(second).reverse().toString("hex");

  assert.equal(computeElectrumMerkleRoot(txid, [sibling], 1), root);
  assert.throws(() => computeElectrumMerkleRoot(txid, [], 1), /position exceeds/);
  assert.throws(() => computeElectrumMerkleRoot(txid, ["bad"], 0), /malformed sibling/);
});

test("transaction status requires identical provider transactions and merkle proofs before reporting confirmed", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const blockHeight = 899_998;
  const proof = { block_height: blockHeight, merkle: [], pos: 0 };
  const header = headerWithMerkleRoot(txid);
  const tip = { height: 900_000, hash: "55".repeat(32) };
  const sessions = [
    makeStatusSession({ raw, proof, header }),
    makeStatusSession({ raw, proof, header }),
  ];

  const result = await getVerifiedTransactionStatus(sessions, tip, txid);
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmations, 3);
  assert.equal(result.blockHeight, blockHeight);
  assert.equal(result.blockHash, hashBlockHeader(header));
  assert.equal(result.verification, "electrum-quorum-merkle-inclusion");
  assert.match(result.verificationLimit, /not local SPV or chainwork/);
});

test("transaction status is pending only when all providers know identical raw bytes but return ordinary no-proof responses", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const tip = { height: 900_000, hash: "55".repeat(32) };
  const sessions = [
    makeStatusSession({ raw, proofError: "transaction not found in block at requested height" }),
    makeStatusSession({ raw, proofError: "No information available about transaction merkle proof" }),
  ];

  const result = await getVerifiedTransactionStatus(sessions, tip, txid);
  assert.equal(result.status, "pending");
  assert.equal(result.confirmations, 0);
  assert.match(result.reason, /not confirmation/);
});

test("transaction status treats unsupported merkle RPC errors as unknown, not pending", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const tip = { height: 900_000, hash: "55".repeat(32) };
  const sessions = [
    makeStatusSession({ raw, proofError: "method not found" }),
    makeStatusSession({ raw, proofError: "method not found" }),
  ];

  const result = await getVerifiedTransactionStatus(sessions, tip, txid);
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /proof lookup failed for a reason other than an ordinary unconfirmed transaction/);
});

test("transaction status returns unknown when only one provider supplies a merkle proof", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const tip = { height: 900_000, hash: "55".repeat(32) };
  const proof = { block_height: 899_999, merkle: [], pos: 0 };
  const header = headerWithMerkleRoot(txid);
  const sessions = [
    makeStatusSession({ raw, proof, header }),
    makeStatusSession({ raw, proofError: "transaction not found in block" }),
  ];

  const result = await getVerifiedTransactionStatus(sessions, tip, txid);
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /disagree about whether/);
});

test("transaction status downgrades from confirmed to pending when a later quorum no longer returns an inclusion proof", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const tip = { height: 900_000, hash: "55".repeat(32) };
  const proof = { block_height: 899_999, merkle: [], pos: 0 };
  const header = headerWithMerkleRoot(txid);

  const confirmed = await getVerifiedTransactionStatus([
    makeStatusSession({ raw, proof, header }),
    makeStatusSession({ raw, proof, header }),
  ], tip, txid);
  const afterReorgObservation = await getVerifiedTransactionStatus([
    makeStatusSession({ raw, proofError: "transaction not found in block" }),
    makeStatusSession({ raw, proofError: "transaction not found in block" }),
  ], tip, txid);

  assert.equal(confirmed.status, "confirmed");
  assert.equal(afterReorgObservation.status, "pending");
  assert.equal(afterReorgObservation.confirmations, 0);
});

test("transaction status stays unknown if a provider cannot return the exact raw transaction", async () => {
  const raw = sampleRawTransactionHex();
  const txid = transactionIdFromHex(raw);
  const tip = { height: 900_000, hash: "55".repeat(32) };
  const sessions = [
    makeStatusSession({ raw, proofError: "transaction not found in block" }),
    makeStatusSession({ transactionError: "Electrum request timed out: blockchain.transaction.get" }),
  ];

  const result = await getVerifiedTransactionStatus(sessions, tip, txid);
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /Not every provider returned/);
});


function invokeServerlessRoute(handler, request) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: null,
      headers: {},
      body: "",
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
        return this;
      },
      end(body = "") {
        this.body = String(body);
        resolve(this);
      },
    };
    Promise.resolve(handler(request, response)).catch(reject);
  });
}

const mockApiRequest = (method, url) => ({
  method,
  url,
  headers: {},
  socket: { remoteAddress: "127.0.0.1" },
});

test("nested transaction-status Vercel route reaches shared API validation", async () => {
  const response = await invokeServerlessRoute(
    transactionStatusHandler,
    mockApiRequest("GET", "/api/transaction/status?txid=not-a-txid"),
  );
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /64 hexadecimal characters/);
});

test("PUSD submission-status route returns 503 when private ledger credentials are missing", async () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const response = await invokeServerlessRoute(
      pusdSubmissionHandler,
      mockApiRequest("GET", "/api/pusd/submission?txid=" + "ab".repeat(32)),
    );
    assert.equal(response.statusCode, 503);
    assert.match(JSON.parse(response.body).error, /ledger is not configured/);
  } finally {
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
});

test("nested PUSD circle verifier route rejects unknown operations before network access", async () => {
  const response = await invokeServerlessRoute(
    pusdCircleVerifyHandler,
    {
      ...mockApiRequest("POST", "/api/pusd/circle/verify"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "unknown" }),
    },
  );
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /Unsupported PUSD Mainnet circle verification operation/);
});

test("nested PUSD submission-status Vercel route validates the transaction ID before ledger access", async () => {
  const response = await invokeServerlessRoute(
    pusdSubmissionHandler,
    mockApiRequest("GET", "/api/pusd/submission?txid=not-a-txid"),
  );
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /64 hexadecimal characters/);
});

test("nested PUSD unspent route reaches the shared API handler", async () => {
  const response = await invokeServerlessRoute(
    pusdUnspentHandler,
    mockApiRequest("GET", "/api/pusd/unspent"),
  );
  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: "Not found." });
});

test("nested PUSD broadcast Vercel route remains hard-locked despite env override", async () => {
  const original = process.env.ENABLE_MAINNET_BROADCAST;
  process.env.ENABLE_MAINNET_BROADCAST = "true";
  try {
    const response = await invokeServerlessRoute(
      pusdBroadcastHandler,
      mockApiRequest("POST", "/api/pusd/broadcast"),
    );
    assert.equal(response.statusCode, 403);
    assert.equal(MAINNET_BROADCAST_ENABLED, false);
    assert.match(JSON.parse(response.body).error, /Mainnet broadcast is disabled/);
  } finally {
    if (original === undefined) delete process.env.ENABLE_MAINNET_BROADCAST;
    else process.env.ENABLE_MAINNET_BROADCAST = original;
  }
});

test("BCH Mainnet payout verifier accepts the V3 final closing layout and its exact amounts", () => {
  const context = createBchMainnetV3ContractContext(bchMainnetVerificationCircle);
  const [m0, m1] = context.members;
  const fee = cashAddressToLockingBytecode(createMainnetTestAddress(13));
  const nft = (commitment, capability = "none") => ({ amount: 0n, category: hexToBin(context.stateCategory), nft: { capability, commitment: hexToBin(commitment) } });
  const out = (script, valueSatoshis, token) => ({ lockingBytecode: hexToBin(script), valueSatoshis, ...(token ? { token } : {}) });
  const credit = "400d030000000000";
  const sourceOutputs = [
    out(context.contractLockingBytecode, 401_000n, nft("540101", "minting")),
    out(context.contractLockingBytecode, 1_000n, nft("5200" + credit)),
    out(context.contractLockingBytecode, 1_000n, nft("5201" + credit)),
    out(fee, 50_000n),
  ];
  const inputScripts = [context.contractLockingBytecode, context.contractLockingBytecode, context.contractLockingBytecode, fee];
  const tx = (outputs) => ({ inputs: new Array(4).fill({}), outputs });
  const closing = [
    out(context.treasuryScript, 4_000n),
    out(m1, 396_000n),
    out(context.initiatorScript, 3_000n),
    out(fee, 49_000n),
  ];
  assert.doesNotThrow(() => assertBchMainnetPayoutLayout(tx(closing), sourceOutputs, inputScripts, [fee], context));
  const shortRefund = closing.slice();
  shortRefund[2] = out(context.initiatorScript, 2_000n);
  assert.throws(() => assertBchMainnetPayoutLayout(tx(shortRefund), sourceOutputs, inputScripts, [fee], context), /exact state and receipt backing/);
  const wrongRecipient = closing.slice();
  wrongRecipient[1] = out(m0, 396_000n);
  assert.throws(() => assertBchMainnetPayoutLayout(tx(wrongRecipient), sourceOutputs, inputScripts, [fee], context), /not the expected token-free recipient/);
  const keptState = closing.slice();
  keptState[2] = out(context.initiatorScript, 3_000n, nft("540201", "minting"));
  assert.throws(() => assertBchMainnetPayoutLayout(tx(keptState), sourceOutputs, inputScripts, [fee], context), /not the expected token-free recipient/);
  const nonFinalSource = sourceOutputs.slice();
  nonFinalSource[0] = out(context.contractLockingBytecode, 401_000n, nft("540000", "minting"));
  assert.throws(() => assertBchMainnetPayoutLayout(tx(closing), nonFinalSource, inputScripts, [fee], context), /exact ordered state/);
});


test("PUSD Mainnet server reconstructs the exact circle and each member escrow script offline", () => {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  assert.match(context.contractLockingBytecode, /^aa20[0-9a-f]{64}87$/);
  assert.equal(cashAddressToLockingBytecode(context.contractAddress), context.contractLockingBytecode);
  assert.equal(context.memberCount, 2);
  assert.equal(context.escrowLockingBytecodes.length, 2);
  for (const script of context.escrowLockingBytecodes) {
    assert.match(script, /^aa20[0-9a-f]{64}87$/);
  }
  assert.equal(context.treasuryScript, "76a91417c8d3de33e0e229101f756dc5f189b123c1c83c88ac");
  assert.throws(() => createPusdMainnetV3ContractContext({
    ...pusdMainnetVerificationCircle, network: "chipnet",
  }), /valid PUSD Mainnet V3 circle context/i);
  assert.throws(() => createPusdMainnetV3ContractContext({
    ...pusdMainnetVerificationCircle,
    members: [pusdMainnetVerificationCircle.members[0], pusdMainnetVerificationCircle.members[0]],
  }), /must be unique/i);
  assert.throws(() => createPusdMainnetV3ContractContext({
    ...pusdMainnetVerificationCircle, treasury: createMainnetTestAddress(44),
  }), /immutable AjoChain treasury/i);
});


test("PUSD Mainnet genesis verifier enforces state category, receipt order and escrow scripts", () => {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  const firstInput = {
    outpointTransactionHash: hexToBin(context.stateCategory),
    outpointIndex: 0,
  };
  const sourceOutputs = [
    pusdOutput(context.initiatorScript, 50_000n),
  ];
  const inputScripts = [context.initiatorScript];
  const zeroCredit = Buffer.alloc(8);
  const transaction = {
    inputs: [firstInput],
    outputs: [
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + zeroCredit.toString("hex"))),
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5201" + zeroCredit.toString("hex"))),
      pusdOutput(context.escrowLockingBytecodes[0], 1_000n),
      pusdOutput(context.escrowLockingBytecodes[1], 1_000n),
      pusdOutput(context.initiatorScript, 44_000n),
    ],
  };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [context.initiatorScript], context, "genesis", {},
  ));
  const wrongEscrow = structuredClone(transaction);
  wrongEscrow.outputs[3].lockingBytecode = hexToBin(context.escrowLockingBytecodes[1]);
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongEscrow, sourceOutputs, inputScripts, [context.initiatorScript], context, "genesis", {},
  ), /wrong member script/);
  const wrongGenesisCategory = structuredClone(transaction);
  wrongGenesisCategory.inputs[0].outpointIndex = 1;
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongGenesisCategory, sourceOutputs, inputScripts, [context.initiatorScript], context, "genesis", {},
  ), /vout 0/);
});

test("PUSD Mainnet deposit verifier checks the member, credit cap, excess-token return and fee change", () => {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  const memberScript = context.members[0];
  const amount = 200_000n;
  const excess = 100_000n;
  const sourceOutputs = [
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + "00".repeat(8))),
    pusdOutput(context.escrowLockingBytecodes[0], 1_000n),
    pusdOutput(memberScript, 1_000n, pusdToken(amount + excess)),
    pusdOutput(memberScript, 50_000n),
  ];
  const inputScripts = [
    context.contractLockingBytecode,
    context.contractLockingBytecode,
    context.escrowLockingBytecodes[0],
    memberScript,
    memberScript,
  ];
  const nextCredit = Buffer.alloc(8);
  nextCredit.writeBigUInt64LE(amount);
  const transaction = {
    inputs: new Array(5).fill({}),
    outputs: [
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + nextCredit.toString("hex"))),
      pusdOutput(context.escrowLockingBytecodes[0], 2_000n, pusdToken(amount)),
      pusdOutput(memberScript, 1_000n, pusdToken(excess)),
      pusdOutput(memberScript, 48_000n),
    ],
  };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 0, amount: amount.toString() },
  ));
  assert.throws(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [context.members[1]], context, "deposit",
    { memberIndex: 0, amount: amount.toString() },
  ), /connected wallet/);
  assert.throws(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 0, amount: (amount + 1n).toString() },
  ), /remaining contribution/);
  const wrongExcessReturn = structuredClone(transaction);
  wrongExcessReturn.outputs[3].token.amount = excess - 1n;
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongExcessReturn, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 0, amount: amount.toString() },
  ), /exact expected fungible PUSD output/);
});

test("PUSD Mainnet server verifier rejects unknown lifecycle operations before provider access", async () => {
  await assert.rejects(
    verifyPusdMainnetCircleTransaction([], { height: 900_000, hash: "00".repeat(32) }, {
      operation: "broadcast",
    }),
    /Unsupported PUSD Mainnet circle verification operation/i,
  );
});


test("PUSD Mainnet genesis verifier enforces vout-0 category origin and exact output ordering", () => {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  const walletScript = context.initiatorScript;
  const stateCategoryBytes = hexToBin(context.stateCategory);
  const sourceOutputs = [pusdOutput(walletScript, 100_000n)];
  const inputScripts = [walletScript];
  const firstInput = {
    outpointTransactionHash: stateCategoryBytes.slice().reverse(),
    outpointIndex: 0,
  };
  const outputs = [
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + "00".repeat(8))),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5201" + "00".repeat(8))),
    pusdOutput(context.escrowLockingBytecodes[0], 1_000n),
    pusdOutput(context.escrowLockingBytecodes[1], 1_000n),
    pusdOutput(walletScript, 90_000n),
  ];
  const transaction = { inputs: [firstInput], outputs };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [walletScript], context, "genesis", {},
  ));

  const wrongCategoryOrigin = structuredClone(transaction);
  wrongCategoryOrigin.inputs[0].outpointIndex = 1;
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongCategoryOrigin, sourceOutputs, inputScripts, [walletScript], context, "genesis", {},
  ), /vout 0/);

  const wrongEscrowOwner = structuredClone(transaction);
  wrongEscrowOwner.outputs[3].lockingBytecode = hexToBin(context.members[0]);
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongEscrowOwner, sourceOutputs, inputScripts, [walletScript], context, "genesis", {},
  ), /expected token-free output/);

  const extraOutput = structuredClone(transaction);
  extraOutput.outputs.push(pusdOutput(walletScript, 546n));
  assert.throws(() => assertPusdMainnetCircleLayout(
    extraOutput, sourceOutputs, inputScripts, [walletScript], context, "genesis", {},
  ), /exact state, receipt, escrow and change outputs/);
});

test("PUSD Mainnet deposit verifier binds member, credit, escrow, excess-token refund and BCH change", () => {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  const memberScript = context.members[0];
  const sourceOutputs = [
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + "00".repeat(8))),
    pusdOutput(context.escrowLockingBytecodes[0], 1_000n),
    pusdOutput(memberScript, 1_000n, pusdToken(15_000n)),
    pusdOutput(memberScript, 50_000n),
  ];
  const inputScripts = [
    context.contractLockingBytecode,
    context.contractLockingBytecode,
    context.escrowLockingBytecodes[0],
    memberScript,
    memberScript,
  ];
  const newCredit = Buffer.alloc(8);
  newCredit.writeBigUInt64LE(10_000n);
  const transaction = {
    inputs: new Array(5).fill({}),
    outputs: [
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + newCredit.toString("hex"))),
      pusdOutput(context.escrowLockingBytecodes[0], 2_000n, pusdToken(10_000n)),
      pusdOutput(memberScript, 1_000n, pusdToken(5_000n)),
      pusdOutput(memberScript, 45_000n),
    ],
  };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 0, amount: "10000" },
  ));

  const wrongMemberIndex = structuredClone(transaction);
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongMemberIndex, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 1, amount: "10000" },
  ), /registered member wallet/);

  const wrongCredit = structuredClone(transaction);
  wrongCredit.outputs[1].token.nft.commitment = hexToBin("52000000000000000000");
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongCredit, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 0, amount: "10000" },
  ), /expected circle NFT/);

  const missingExcessRefund = structuredClone(transaction);
  missingExcessRefund.outputs.pop();
  assert.throws(() => assertPusdMainnetCircleLayout(
    missingExcessRefund, sourceOutputs, inputScripts, [memberScript], context, "deposit",
    { memberIndex: 0, amount: "10000" },
  ), /return excess PUSD to the member wallet/);
});

test("PUSD Mainnet final payout verifier accepts exact member backing refunds and non-initiator sponsor", () => {
  const { context, feeScript, sourceOutputs, inputScripts } = makePusdPayoutFixture(1);
  const feeChange = 57_000n;
  const transaction = {
    inputs: new Array(6).fill({}),
    outputs: [
      pusdOutput(context.treasuryScript, 1_000n, pusdToken(4_000n)),
      pusdOutput(context.members[1], 1_000n, pusdToken(396_000n)),
      pusdOutput(context.members[0], 2_000n),
      pusdOutput(context.members[1], 2_000n),
      pusdOutput(context.initiatorScript, 1_000n),
      pusdOutput(feeScript, feeChange),
    ],
  };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [feeScript], context, "payout", {},
  ));

  const wrongSponsorChange = structuredClone(transaction);
  wrongSponsorChange.outputs[5].lockingBytecode = hexToBin(context.initiatorScript);
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongSponsorChange, sourceOutputs, inputScripts, [feeScript], context, "payout", {},
  ), /token-free output/);

  const shortMemberRefund = structuredClone(transaction);
  shortMemberRefund.outputs[2].valueSatoshis = 1_999n;
  assert.throws(() => assertPusdMainnetCircleLayout(
    shortMemberRefund, sourceOutputs, inputScripts, [feeScript], context, "payout", {},
  ), /each member's exact escrow and receipt BCH backing/);

  const redirectedStateBacking = structuredClone(transaction);
  redirectedStateBacking.outputs[4].valueSatoshis = 999n;
  assert.throws(() => assertPusdMainnetCircleLayout(
    redirectedStateBacking, sourceOutputs, inputScripts, [feeScript], context, "payout", {},
  ), /exact state BCH backing/);
});

test("PUSD Mainnet payout verifier checks reserve carry-forward and exact escrow credits", () => {
  const { context, feeScript, sourceOutputs, inputScripts } = makePusdPayoutFixture(0);
  const receipt0 = Buffer.alloc(8);
  receipt0.writeBigUInt64LE(200_000n);
  const receipt1 = Buffer.alloc(8);
  receipt1.writeBigUInt64LE(0n);
  const transaction = {
    inputs: new Array(6).fill({}),
    outputs: [
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540101", "minting")),
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + receipt0.toString("hex"))),
      pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5201" + receipt1.toString("hex"))),
      pusdOutput(context.escrowLockingBytecodes[0], 1_000n, pusdToken(200_000n)),
      pusdOutput(context.escrowLockingBytecodes[1], 1_000n),
      pusdOutput(context.treasuryScript, 1_000n, pusdToken(4_000n)),
      pusdOutput(context.members[0], 1_000n, pusdToken(196_000n)),
      pusdOutput(feeScript, 56_000n),
    ],
  };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [feeScript], context, "payout", {},
  ));
  const wrongReserve = structuredClone(transaction);
  wrongReserve.outputs[1].token.nft.commitment = hexToBin("52000000000000000000");
  assert.throws(() => assertPusdMainnetCircleLayout(
    wrongReserve, sourceOutputs, inputScripts, [feeScript], context, "payout", {},
  ), /expected circle NFT/);
});

test("PUSD Mainnet verifier requires initiator-only cancellation before first payout", () => {
  const context = createPusdMainnetV3ContractContext(pusdMainnetVerificationCircle);
  const feeScript = context.initiatorScript;
  const credit0 = Buffer.alloc(8);
  credit0.writeBigUInt64LE(0n);
  const credit1 = Buffer.alloc(8);
  credit1.writeBigUInt64LE(50_000n);
  const sourceOutputs = [
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "540000", "minting")),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5200" + credit0.toString("hex"))),
    pusdOutput(context.contractLockingBytecode, 1_000n, pusdNft(context, "5201" + credit1.toString("hex"))),
    pusdOutput(context.escrowLockingBytecodes[0], 1_000n),
    pusdOutput(context.escrowLockingBytecodes[1], 1_000n, pusdToken(50_000n)),
    pusdOutput(feeScript, 60_000n),
  ];
  const inputScripts = [
    context.contractLockingBytecode,
    context.contractLockingBytecode,
    context.contractLockingBytecode,
    context.escrowLockingBytecodes[0],
    context.escrowLockingBytecodes[1],
    feeScript,
  ];
  const transaction = {
    inputs: new Array(6).fill({}),
    outputs: [
      pusdOutput(context.members[0], 2_000n),
      pusdOutput(context.members[1], 2_000n, pusdToken(50_000n)),
      pusdOutput(context.initiatorScript, 56_000n),
    ],
  };
  assert.doesNotThrow(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [feeScript], context, "cancel", {},
  ));
  assert.throws(() => assertPusdMainnetCircleLayout(
    transaction, sourceOutputs, inputScripts, [cashAddressToLockingBytecode(createMainnetTestAddress(45))], context, "cancel", {},
  ), /initiator-only/);
});

test("BCH Mainnet circle broadcast is gated and refuses before any verification or relay", async () => {
  assert.equal(BCH_MAINNET_CIRCLE_BROADCAST_ENABLED, true);
  let called = false;
  const sessions = [{ call: async () => { called = true; } }, { call: async () => { called = true; } }];
  await assert.rejects(
    broadcastBchMainnetCircleTransaction(sessions, { height: 1, hash: "00" }, { operation: "payout" }, false),
    /disabled until the release is approved/,
  );
  await assert.rejects(
    broadcastBchMainnetCircleTransaction(sessions, { height: 1, hash: "00" }, { operation: "bogus" }, true),
    /Unsupported BCH Mainnet circle verification operation/,
  );
  assert.equal(called, false);
});
