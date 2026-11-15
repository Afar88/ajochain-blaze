# Product carry-forward requirements

This is the implementation checklist for improvements previously requested for AjoChain. It is a rebuild in this repository, not a copy of the frozen V1 application.

## Experience and navigation
- Mature, clean fintech visual language with responsive mobile-first layouts.
- Put the current circle creation experience first; do not lead with legacy/V1 creation.
- Keep legacy circle discovery and compatibility in a clearly separate area so existing links and history remain discoverable where supported.

## Circle creation
- Support BCH and PUSD (CashToken) as selectable contribution assets.
- Enforce a minimum of 2 members in both the interface and domain validation.
- Explain the asset, contribution amount, frequency, member count, and payout order before wallet authorization.

## Member-level accounting
- Credit payments to the member and wallet that made them, never only to the aggregate circle balance.
- Preserve unused/overpaid contribution as that member's own credit.
- Prevent duplicate payment/period crediting and reconcile totals to confirmed chain activity.
- Use integer base units for BCH and token quantities.

## Wallet and transaction safety
- WizardConnect is the required wallet connection path; validate Selene support and reconnect behavior on real devices.
- Display the active wallet's actual address and network.
- Decode the final signed transaction and compare inputs, outputs, fees, change, CashToken categories, amounts, NFT capabilities and commitments with the approved intent.
- Keep signing/broadcast and all real-value circle operations disabled until independent wallet, contract and transaction review gates pass.

## Delivery
- The frozen V1 repository and website remain unchanged.
- This repository owns its own source, branches, CI and deployment.
- A public preview may be read-only while mainnet safety gates are incomplete.
