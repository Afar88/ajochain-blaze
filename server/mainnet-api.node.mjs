import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertPreviousTransactionsAgree,
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
  mainnetApiErrorStatus,
  lockingBytecodeToScriptHash,
  normalizeElectrumUnspent,
  MAINNET_BROADCAST_ENABLED,
  createMainnetApiServer,
} from "./mainnet-api.mjs";

const mainnetP2pkh = "bitcoincash:qq2azmyyv6dtgczexyalqar70q036yund54qgw0wg6";
const testnetP2pkh = "bchtest:qq2azmyyv6dtgczexyalqar70q036yund53jvfde0x";
const txid = "ab".repeat(32);

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


test("ambiguous PUSD relay outcomes are exposed as retry-blocked service errors", () => {
  assert.equal(
    mainnetApiErrorStatus("PUSD broadcast result is UNKNOWN for " + "ab".repeat(32) + ". It was not retried."),
    503,
  );
  assert.equal(mainnetApiErrorStatus("Rate limit exceeded; retry in one minute."), 429);
  assert.equal(mainnetApiErrorStatus("Request body exceeds the permitted size."), 413);
  assert.equal(mainnetApiErrorStatus("Invalid PUSD amount."), 400);
});
