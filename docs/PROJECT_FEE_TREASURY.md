# Shared AjoChain project-fee treasury

The immutable Mainnet project-fee destination is shared by native BCH circles and ParyonUSD (PUSD) CashToken circles:

`bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q`

It is a token-aware P2PKH CashAddress. The decoded public-key hash is:

`17c8d3de33e0e229101f756dc5f189b123c1c83c`

The covenant's output locking bytecode is the ordinary P2PKH script for that hash. CashToken PUSD fee outputs use the same locking script with the exact PUSD category and fungible fee amount.

The project fee is a separate output equal to floor(gross circle pot / 100), i.e. 1% in integer base units. Miner fees and BCH carrier satoshis are separate and must never be deducted from the project-fee amount.

The existing Chipnet BCH prototype keeps its separate `bchtest:` treasury. It must not be used for Mainnet circles.

Changing the Mainnet project-fee destination requires a new, separately versioned covenant; existing deployed circles keep the treasury address committed by their constructor.
