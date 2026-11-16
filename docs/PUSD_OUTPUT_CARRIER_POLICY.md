# PUSD token-output carrier validation

BLAZE builds PUSD recipient and change outputs using Libauth's `getDustThreshold` over the complete serialized output (including the CashToken prefix and locking bytecode). The minimum is not a hard-coded universal 1,000-satoshi value; it depends on the serialized output size and the node's dust relay fee policy.

The PUSD signed-transaction verifier now recomputes that threshold from the exact decoded output and rejects any token output whose BCH carrier is below it. The server API applies the same rule before it could ever accept a PUSD broadcast. Tests cover an under-carried PUSD output and the server helper.

This is a relay-standardness and spendability guard, in addition to CashTokens consensus token conservation. It does **not** turn on PUSD sending. The server `MAINNET_BROADCAST_ENABLED` constant and client `PUSD_MAINNET_SPENDING_ENABLED` guard remain false.
