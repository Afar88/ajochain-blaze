import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertPreviousTransactionsAgree,
  assertUnspentSnapshotsAgree,
  cashAddressToLockingBytecode,
  hashBlockHeader,
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

test("raw previous transaction bytes must agree across the Electrum quorum", () => {
  const raw = "01000000" + "00".repeat(10);
  assert.equal(assertPreviousTransactionsAgree([{ hex: raw }, { hex: raw.toUpperCase() }]), raw);
  assert.throws(() => assertPreviousTransactionsAgree([{ hex: raw }, { hex: "02000000" + "00".repeat(10) }]), /disagree/);
  assert.throws(() => assertPreviousTransactionsAgree([{ hex: raw }]), /at least two/);
  assert.throws(() => assertPreviousTransactionsAgree([{ hex: "not-hex" }, { hex: raw }]), /malformed/);
});
