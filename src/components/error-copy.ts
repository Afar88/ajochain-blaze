export function plainErrorSummary(error: string): string {
  const message = error.toLowerCase();
  if (/wallet|address|selene|receive/.test(message)) {
    return "Check your wallet and try again.";
  }
  if (/network|timeout|electrum|provider|connection|fetch|offline/.test(message)) {
    return "Can't connect right now. Try again.";
  }
  if (/signature|signed|broadcast|transaction|payment|coin|utxo|token|pusd|bch/.test(message)) {
    return "This step couldn't be completed. Check details.";
  }
  return "Something went wrong. Try again.";
}
