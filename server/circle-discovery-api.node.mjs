import test from "node:test";
import assert from "node:assert/strict";
import { encodeCashAddress } from "@bitauth/libauth";
import {
  createCircleDiscoveryHandler,
  decodeInvite,
} from "./circle-discovery-api.mjs";

function makeAddress(seed) {
  const encoded = encodeCashAddress({
    prefix: "bchtest",
    type: "p2pkh",
    payload: new Uint8Array(20).fill(seed),
  });
  if (typeof encoded === "string") throw new Error(encoded);
  return encoded.address;
}

function makeInvite() {
  const members = [makeAddress(11), makeAddress(12)];
  const params = {
    version: 2,
    covenant: "fee-v3-auto-reserve-guarded",
    name: "Discovery test circle",
    network: "chipnet",
    members,
    contribution: "200000",
    maxFee: "10000",
    stateCategory: "ab".repeat(32),
    initiator: members[0],
    treasury: makeAddress(13),
  };
  return Buffer.from(JSON.stringify(params)).toString("base64url");
}

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
  };
}

function requestMock(body, ip = "127.0.0.1") {
  return { method: "POST", headers: { "x-forwarded-for": ip }, body };
}

test("circle invite validation accepts a valid Chipnet V3 circle", () => {
  const decoded = decodeInvite(makeInvite());
  assert.equal(decoded.params.network, "chipnet");
  assert.equal(decoded.members.length, 2);
  assert.equal(decoded.initiatorAddress, decoded.members[0]);
});

test("circle invite validation rejects Mainnet and unsupported covenant records", () => {
  const encoded = makeInvite();
  const params = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  params.network = "mainnet";
  assert.throws(() => decodeInvite(Buffer.from(JSON.stringify(params)).toString("base64url")), /valid Chipnet V3/);
  params.network = "chipnet";
  params.covenant = "fee-v1";
  assert.throws(() => decodeInvite(Buffer.from(JSON.stringify(params)).toString("base64url")), /valid Chipnet V3/);
});

test("circle invite validation rejects duplicate members and a mismatched initiator", () => {
  const encoded = makeInvite();
  const params = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  params.members[1] = params.members[0];
  assert.throws(() => decodeInvite(Buffer.from(JSON.stringify(params)).toString("base64url")), /more than once/);
  params.members = [makeAddress(11), makeAddress(12)];
  params.initiator = makeAddress(14);
  assert.throws(() => decodeInvite(Buffer.from(JSON.stringify(params)).toString("base64url")), /first circle member/);
});

test("circle discovery registers a circle idempotently and stores member indexes", async () => {
  const encoded = makeInvite();
  const queries = [];
  const sql = {
    async query(statement, params) {
      queries.push({ statement, params });
      if (statement.includes("INSERT INTO ajo_blaze_circle_registry")) return [{ circle_key: params[0] }];
      return [];
    },
  };
  const handler = createCircleDiscoveryHandler({ getSql: async () => sql });
  const response = responseMock();
  await handler(requestMock({ action: "register", encoded, genesisTxid: "cd".repeat(32) }), response);
  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).circle.memberCount, 2);
  const registerQuery = queries.find((query) => query.statement.includes("INSERT INTO ajo_blaze_circle_registry"));
  assert.equal(registerQuery.params[8], 2);
  assert.equal(JSON.parse(registerQuery.params[9]).length, 2);
  assert.equal(queries.filter((query) => query.statement.includes("CREATE TABLE")).length, 2);
});

test("circle discovery only returns circles matched to supplied member addresses", async () => {
  const encoded = makeInvite();
  const memberAddress = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).members[0].toLowerCase();
  const sql = {
    async query(statement, params) {
      if (statement.includes("SELECT c.encoded_invite")) {
        assert.deepEqual(params[0], [memberAddress]);
        return [{ encoded, name: "Discovery test circle", network: "chipnet", stateCategory: "ab".repeat(32), createdAt: new Date().toISOString() }];
      }
      return [];
    },
  };
  const handler = createCircleDiscoveryHandler({ getSql: async () => sql });
  const response = responseMock();
  await handler(requestMock({ action: "discover", addresses: [memberAddress] }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).circles.length, 1);
});

test("circle discovery rejects malformed addresses before querying records", async () => {
  let queried = false;
  const sql = { async query() { queried = true; return []; } };
  const handler = createCircleDiscoveryHandler({ getSql: async () => sql });
  const response = responseMock();
  await handler(requestMock({ action: "discover", addresses: ["bitcoincash:invalid"] }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(queried, false);
});
