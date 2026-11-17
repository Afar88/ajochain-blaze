import { binToHex, decodeCashAddress, hexToBin } from "@bitauth/libauth";

/**
 * Shared AjoChain project-fee destination for real BCH Mainnet circles,
 * regardless of whether the circle pot is native BCH or ParyonUSD CashTokens.
 *
 * This is a token-aware P2PKH CashAddress. Its locking script is the standard
 * P2PKH script; CashTokens use the same script with token metadata in outputs.
 */
export const MAINNET_PROJECT_TREASURY_ADDRESS =
  "bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q";

export const MAINNET_PROJECT_TREASURY_PKH_HEX =
  "17c8d3de33e0e229101f756dc5f189b123c1c83c";

export const MAINNET_PROJECT_TREASURY_LOCKING_BYTECODE =
  "76a914" + MAINNET_PROJECT_TREASURY_PKH_HEX + "88ac";

export const CHIPNET_PROJECT_TREASURY_ADDRESS =
  "bchtest:zpn8rsua556gewluc0gf5mq4v343w8vc9vfcnq22v6";

/** Decode and fail closed if the configured Mainnet treasury ever drifts. */
export function getMainnetProjectTreasuryPkh(): Uint8Array {
  const decoded = decodeCashAddress(MAINNET_PROJECT_TREASURY_ADDRESS);
  if (typeof decoded === "string" || decoded.prefix !== "bitcoincash" ||
      String(decoded.type).toLowerCase() !== "p2pkhwithtokens" ||
      binToHex(decoded.payload).toLowerCase() !== MAINNET_PROJECT_TREASURY_PKH_HEX) {
    throw new Error("Configured AjoChain Mainnet project treasury is invalid or has changed.");
  }
  return hexToBin(MAINNET_PROJECT_TREASURY_PKH_HEX);
}
