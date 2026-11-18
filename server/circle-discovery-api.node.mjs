import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/circles/index.mjs";

function invoke(method) {
  const headers = {};
  const response = {
    setHeader(name, value) { headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
  const request = new Proxy({ method }, {
    get(target, key) {
      assert.equal(key, "method", "Disabled discovery must not read request data");
      return target[key];
    },
  });
  handler(request, response);
  return { status: response.statusCode, headers, body: response.body };
}

test("the deployed discovery route rejects all POSTs even if database URLs are configured", () => {
  const envs = ["BLAZE_CIRCLE_DISCOVERY_DATABASE_URL", "DATABASE_URL"];
  const before = envs.map((key) => process.env[key]);
  try {
    for (const key of envs) process.env[key] = "postgresql://unused.example.invalid/no-access";
    assert.deepEqual(invoke("POST"), {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
      body: { error: "Shared circle discovery is disabled. Use a circle invite link." },
    });
  } finally {
    for (const [index, key] of envs.entries()) {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    }
  }
});

test("the discovery route only accepts POST and never caches the response", () => {
  const { status, headers } = invoke("GET");
  assert.equal(status, 405);
  assert.equal(headers.allow, "POST");
  assert.equal(headers["cache-control"], "no-store");
});
