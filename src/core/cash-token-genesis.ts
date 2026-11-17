import type { SpendableUtxo } from "cashscript";

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
