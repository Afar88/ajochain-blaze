import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const targets = [
  {
    name: "BCH Mainnet V3 auto-reserve circle",
    source: "contracts/AjoCircleV3AutoReserve.cash",
    artifact: "contracts/AjoCircleV3AutoReserve.json",
  },
  {
    name: "PUSD Mainnet V3 circle",
    source: "contracts/AjoCirclePUSDV3Mainnet.cash",
    artifact: "contracts/AjoCirclePUSDV3Mainnet.json",
  },
  {
    name: "PUSD Mainnet V3 member escrow",
    source: "contracts/AjoPUSDMemberEscrowV3.cash",
    artifact: "contracts/AjoPUSDMemberEscrowV3.json",
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRequired(path) {
  try {
    return readFileSync(resolve(path));
  } catch (error) {
    throw new Error("Required contract fingerprint input is missing: " + path + " (" +
      (error instanceof Error ? error.message : String(error)) + ")");
  }
}

for (const target of targets) {
  const sourceBytes = readRequired(target.source);
  const artifactBytes = readRequired(target.artifact);
  let artifact;
  try {
    artifact = JSON.parse(artifactBytes.toString("utf8"));
  } catch {
    throw new Error("Compiled CashScript artifact is not valid JSON: " + target.artifact);
  }
  const bytecode = typeof artifact.bytecode === "string"
    ? artifact.bytecode.replace(/^0x/i, "").toLowerCase()
    : "";
  if (!/^(?:[0-9a-f]{2})+$/.test(bytecode)) {
    throw new Error("Compiled CashScript artifact has missing or malformed bytecode: " + target.artifact);
  }
  const abi = Array.isArray(artifact.abi) ? artifact.abi : [];
  const constructorInputs = Array.isArray(artifact.constructorInputs)
    ? artifact.constructorInputs
    : Array.isArray(artifact.constructor?.inputs)
      ? artifact.constructor.inputs
      : [];

  const record = {
    name: target.name,
    contractName: typeof artifact.contractName === "string" ? artifact.contractName : "unknown",
    sourcePath: target.source,
    sourceSha256: sha256(sourceBytes),
    artifactPath: target.artifact,
    artifactJsonSha256: sha256(artifactBytes),
    compiledBytecodeSha256: sha256(Buffer.from(bytecode, "hex")),
    compiledBytecodeBytes: bytecode.length / 2,
    constructorInputCount: constructorInputs.length,
    abiFunctionCount: abi.length,
    compiler: artifact.compiler ?? null,
  };
  console.log(JSON.stringify(record));
}
