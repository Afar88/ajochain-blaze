import type { SpendableUtxo } from "cashscript";

export const CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS = 1_000n;
export const CASH_TOKEN_GENESIS_SETUP_MIN_CHANGE_SATOSHIS = 5_546n;

/**
 * Returns safe wallet change for the setup transaction, or undefined when
 * the input value cannot fund the output, fee, and a reserve for the follow-up
 * category-creation transaction.
 */
export function calculateGenesisSetupChange(
  totalInputSatoshis: bigint,
  feeSatoshis: bigint,
): bigint | undefined {
  if (totalInputSatoshis < 0n || feeSatoshis < 0n) return undefined;
  const change = totalInputSatoshis -
    CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS -
    feeSatoshis;
  return change >= CASH_TOKEN_GENESIS_SETUP_MIN_CHANGE_SATOSHIS
    ? change
    : undefined;
}

/**
 * CashTokens category genesis requires spending a non-token output at vout 0.
 * The protocol does not impose a 3,000-satoshi minimum on that outpoint:
 * other eligible wallet inputs can provide the remaining transaction value.
 */
export function selectCashTokensGenesisUtxo(
  utxos: readonly SpendableUtxo[],
): SpendableUtxo | undefined {
  return utxos
    .filter((utxo) =>
      utxo.vout === 0 &&
      !utxo.token &&
      typeof utxo.satoshis === "bigint" &&
      utxo.satoshis > 0n
    )
    .sort((a, b) =>
      a.satoshis === b.satoshis
        ? a.txid.localeCompare(b.txid)
        : a.satoshis > b.satoshis ? -1 : 1
    )[0];
}
