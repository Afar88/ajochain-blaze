import { createHash } from "node:crypto";
import { decodeCashAddress, binToHex } from "@bitauth/libauth";
import { neon } from "@neondatabase/serverless";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_DISCOVERY_ADDRESSES = 51;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

export class CircleDiscoveryConfigurationError extends Error {
  constructor() {
    super("The separate AjoChain Blaze circle database is not configured.");
    this.name = "CircleDiscoveryConfigurationError";
    this.statusCode = 503;
  }
}

function canonicalChipnetP2pkhAddress(address) {
  if (typeof address !== "string" || address.length > 128 || !address.trim()) {
    throw new Error("A valid Chipnet BCH address is required.");
  }
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string" || decoded.prefix !== "bchtest" ||
      !String(decoded.type).toLowerCase().startsWith("p2pkh")) {
    throw new Error("Only Chipnet P2PKH wallet addresses can be used for circle discovery.");
  }
  return {
    address: address.trim().toLowerCase(),
    identity: decoded.prefix + ":" + String(decoded.type).toLowerCase() + ":" + binToHex(decoded.payload).toLowerCase(),
  };
}

export function decodeInvite(encoded) {
  if (typeof encoded !== "string" || encoded.length < 8 || encoded.length > 20_000 ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("The circle invite is missing or malformed.");
  }
  let params;
  try {
    params = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("The circle invite is not valid base64url JSON.");
  }
  if (!params || typeof params !== "object" || params.version !== 2 ||
      params.network !== "chipnet" ||
      params.covenant !== "fee-v3-auto-reserve-guarded" ||
      typeof params.name !== "string" || params.name.trim().length < 3 || params.name.trim().length > 60 ||
      typeof params.stateCategory !== "string" || !/^[0-9a-f]{64}$/i.test(params.stateCategory) ||
      typeof params.contribution !== "string" || !/^[0-9]+$/.test(params.contribution) ||
      typeof params.maxFee !== "string" || !/^[0-9]+$/.test(params.maxFee) ||
      typeof params.initiator !== "string" || typeof params.treasury !== "string" ||
      !Array.isArray(params.members) || params.members.length < 2 || params.members.length > 5) {
    throw new Error("Only a valid Chipnet V3 automatic-reserve circle can be registered.");
  }
  if (BigInt(params.contribution) < 200_000n || BigInt(params.maxFee) < 1_000n) {
    throw new Error("The circle contribution or maximum fee is below the supported minimum.");
  }

  const members = params.members.map(canonicalChipnetP2pkhAddress);
  if (new Set(members.map((member) => member.identity)).size !== members.length) {
    throw new Error("A circle cannot register the same wallet address more than once.");
  }
  const initiator = canonicalChipnetP2pkhAddress(params.initiator);
  const treasury = canonicalChipnetP2pkhAddress(params.treasury);
  if (initiator.identity !== members[0].identity) {
    throw new Error("The registered initiator must be the first circle member.");
  }
  return {
    params,
    name: params.name.trim(),
    stateCategory: params.stateCategory.toLowerCase(),
    initiatorAddress: initiator.address,
    treasuryAddress: treasury.address,
    members: members.map((member) => member.address),
  };
}

function normaliseDiscoveryAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_DISCOVERY_ADDRESSES) {
    throw new Error("Supply between 1 and 100 connected wallet receive addresses.");
  }
  const normalised = addresses.map((address) => canonicalChipnetP2pkhAddress(address));
  return [...new Set(normalised.map((entry) => entry.address))];
}

function circleKey(network, stateCategory, encodedInvite) {
  const inviteHash = createHash("sha256").update(encodedInvite).digest("hex");
  return createHash("sha256")
    .update(network + ":" + stateCategory.toLowerCase() + ":" + inviteHash)
    .digest("hex");
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  if (typeof request.body === "string") {
    if (Buffer.byteLength(request.body) > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    return JSON.parse(request.body);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function ensureSchema(sql) {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS ajo_blaze_circle_registry (
      circle_key text PRIMARY KEY,
      network text NOT NULL CHECK (network = 'chipnet'),
      state_category text NOT NULL CHECK (state_category ~ '^[0-9a-f]{64}$'),
      encoded_invite text NOT NULL,
      circle_name text NOT NULL,
      covenant text NOT NULL,
      initiator_address text NOT NULL,
      treasury_address text NOT NULL,
      genesis_txid char(64),
      member_count smallint NOT NULL CHECK (member_count BETWEEN 2 AND 5),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now()
    )
  `, []);
  // Existing records created by an earlier release may lack a transaction ID.
  // Allow verified local-member backfill to attach those circles, then enrich
  // the row with the exact genesis txid whenever a new creation supplies it.
  await sql.query(`
    ALTER TABLE ajo_blaze_circle_registry
    ALTER COLUMN genesis_txid DROP NOT NULL
  `, []);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS ajo_blaze_circle_members (
      circle_key text NOT NULL REFERENCES ajo_blaze_circle_registry(circle_key) ON DELETE CASCADE,
      member_address text NOT NULL,
      member_index smallint NOT NULL CHECK (member_index BETWEEN 0 AND 4),
      PRIMARY KEY (circle_key, member_address),
      UNIQUE (circle_key, member_index)
    )
  `, []);
  await sql.query(`
    CREATE INDEX IF NOT EXISTS ajo_blaze_circle_members_address_idx
    ON ajo_blaze_circle_members (member_address, circle_key)
  `, []);
}

function getClientIp(request) {
  const forwarded = request.headers?.["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (typeof first === "string" ? first.split(",")[0].trim() : "") || "unknown";
}

export function createCircleDiscoveryHandler({ getSql } = {}) {
  let schemaPromise = null;
  const rateBuckets = new Map();
  const resolveSql = getSql || (() => {
    const databaseUrl = process.env.BLAZE_CIRCLE_DISCOVERY_DATABASE_URL;
    if (!databaseUrl) throw new CircleDiscoveryConfigurationError();
    return neon(databaseUrl);
  });

  return async function handleCircleDiscovery(request, response) {
    const send = (status, payload) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(payload));
    };

    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(405, { error: "Use POST for circle discovery." });
    }

    const now = Date.now();
    const ip = getClientIp(request);
    const bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
      rateBuckets.set(ip, { startedAt: now, count: 1 });
    } else {
      bucket.count += 1;
      if (bucket.count > RATE_LIMIT) return send(429, { error: "Circle discovery rate limit reached. Try again shortly." });
    }
    if (rateBuckets.size > 2_000) {
      for (const [key, value] of rateBuckets) {
        if (now - value.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
      }
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return send(400, { error: "The request body must be valid JSON and no larger than 32 KB." });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return send(400, { error: "A JSON object is required." });
    }

    let registration = null;
    let addresses = null;
    if (body.action === "register") {
      try {
        registration = decodeInvite(body.encoded);
      } catch (error) {
        return send(400, { error: error.message });
      }
      if (body.genesisTxid !== undefined && body.genesisTxid !== null &&
          (typeof body.genesisTxid !== "string" || !/^[0-9a-f]{64}$/i.test(body.genesisTxid))) {
        return send(400, { error: "The optional Chipnet genesis transaction ID is malformed." });
      }
    } else if (body.action === "discover") {
      try {
        addresses = normaliseDiscoveryAddresses(body.addresses);
      } catch (error) {
        return send(400, { error: error.message });
      }
    } else {
      return send(400, { error: "Action must be either register or discover." });
    }

    try {
      const sql = await resolveSql();
      if (!schemaPromise) {
        schemaPromise = ensureSchema(sql).catch((error) => {
          schemaPromise = null;
          throw error;
        });
      }
      await schemaPromise;

      if (body.action === "register") {
        const { params, name, stateCategory, initiatorAddress, treasuryAddress, members } = registration;
        const key = circleKey("chipnet", stateCategory, body.encoded);
        const result = await sql.query(`
          WITH circle AS (
            INSERT INTO ajo_blaze_circle_registry (
              circle_key, network, state_category, encoded_invite, circle_name,
              covenant, initiator_address, treasury_address, genesis_txid, member_count
            )
            VALUES ($1, 'chipnet', $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (circle_key) DO UPDATE
              SET genesis_txid = COALESCE(ajo_blaze_circle_registry.genesis_txid, EXCLUDED.genesis_txid),
                  last_seen_at = now()
              WHERE ajo_blaze_circle_registry.encoded_invite = EXCLUDED.encoded_invite
                AND (
                  ajo_blaze_circle_registry.genesis_txid IS NULL OR
                  EXCLUDED.genesis_txid IS NULL OR
                  ajo_blaze_circle_registry.genesis_txid = EXCLUDED.genesis_txid
                )
            RETURNING circle_key
          ),
          registered_members AS (
            INSERT INTO ajo_blaze_circle_members (circle_key, member_address, member_index)
            SELECT circle.circle_key, member.address, (member.ordinality - 1)::smallint
            FROM circle
            CROSS JOIN LATERAL jsonb_array_elements_text($10::jsonb)
              WITH ORDINALITY AS member(address, ordinality)
            ON CONFLICT (circle_key, member_address) DO NOTHING
            RETURNING circle_key
          )
          SELECT circle_key FROM circle
        `, [
          key, stateCategory, body.encoded, name, params.covenant,
          initiatorAddress, treasuryAddress, body.genesisTxid ? body.genesisTxid.toLowerCase() : null,
          members.length, JSON.stringify(members),
        ]);
        if (!result.length) {
          return send(409, { error: "A different circle is already registered for this on-chain state category." });
        }
        return send(201, { circle: { circleKey: key, name, network: "chipnet", stateCategory, memberCount: members.length } });
      }

      if (body.action === "discover") {
        const result = await sql.query(`
          SELECT c.encoded_invite AS encoded,
                 c.circle_name AS name,
                 c.network,
                 c.state_category AS "stateCategory",
                 c.created_at AS "createdAt"
          FROM ajo_blaze_circle_registry c
          INNER JOIN ajo_blaze_circle_members m ON m.circle_key = c.circle_key
          WHERE m.member_address = ANY($1::text[])
          ORDER BY c.created_at DESC
          LIMIT 100
        `, [addresses]);
        return send(200, { circles: result });
      }

    } catch (error) {
      if (error instanceof CircleDiscoveryConfigurationError) {
        return send(503, { error: error.message });
      }
      // Do not leak database URLs, SQL details, or provider credentials to clients.
      return send(503, { error: "The AjoChain Blaze circle discovery service is temporarily unavailable." });
    }
  };
}

export const handleCircleDiscovery = createCircleDiscoveryHandler();
