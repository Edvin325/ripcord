# Threat model

This is what Ripcord protects against, what it does not, and who carries each risk. It is unaudited hackathon software.

## Who has to be trusted

| Party | Trusted for | If they fail |
| --- | --- | --- |
| Bitcoin | Enforcing the script | Nothing here survives that |
| NEAR's MPC signers | Honestly signing only what the contract asks | See "A colluding signer majority" |
| NEAR validators | Running the contract correctly | See "NEAR stops" |
| Bitcoin light client relayers | Keeping headers current. They cannot forge history: headers carry proof of work | New deposits cannot be proven, and auctions cannot start, until it catches up |
| Ripcord's authors | Nothing, once the contract's keys are removed | There is no admin method |

## What it protects against

**A dip.** There is no price anywhere in the contract, so no price can trigger anything. `crates/ripcord-core` has no price input.

**A stale or manipulated oracle.** There is no oracle. The BTC price stored in `pyth-oracle.near` was about 73 days old on 7 Nov 2026. Pyth is pull-based, so an app can push updates, but a protocol built on a price inherits that dependency.

**NEAR stops, or the signers go offline.** The owner's Bitcoin script path opens at the escape height and needs nothing but the owner's key. The escape ticket is a transaction signed in advance, so even the key is not needed on the day.

**This website or our relayer disappears.** Every action is an ordinary contract call. `tools/ripcord.mjs` and `tools/keeper.mjs` do the same work, and anyone can run them.

**A forged deposit.** The contract computes the txid from the raw transaction itself, reads the amount from the output, and has the light client check the proof. Changing the amount changes the txid. The light client's coinbase proof closes the 64-byte transaction forgery, and the parser refuses 64-byte transactions too.

**A griefing deposit.** Proofs are open to anyone. A vault states the smallest deposit it accepts, so blocking one means gifting that much.

**A leaked app key.** `borrow`, `withdraw`, `release` and `cancel_offer` need one yoctoNEAR, so a function-call key cannot use them.

**A broken lender account.** Payments are pulled, not pushed, so a lender who cannot receive tokens cannot make a repayment fail.

**A bad signature.** The contract recovers the signer from every MPC response and refuses one that does not match the vault's key.

## What it does not protect against

**A colluding signer majority.** If enough MPC operators collude, they can spend lock 1 before the escape height. The ripcord protects against signers being **offline**, not **malicious**. This is the same trust as nBTC and every other Chain Signatures product. The ripcord adds a way out of a shutdown, not a defence against theft by the network.

**A bug in the contract.** Once its keys are removed, nothing can patch it. It has had no audit.

**A lender's price risk.** A lender can end up with Bitcoin worth less than the loan. That is the trade for having no liquidation, and `research/lender-backtest.md` shows how often it would have happened.

**Losing the key and the ticket.** If you lose both, and NEAR has stopped, the coins are gone. While NEAR runs, the contract can still release them.

## Races worth knowing about

**The escape height and the lender.** After the escape height the owner can take the coins, even with a loan unpaid. `open_loan` refuses any loan whose due date, grace, auction and safety margin do not all fit before that height, so a lender always has time to act. If nobody acts in that whole window, the lender can lose the collateral.

**Starting too late.** If nobody starts the auction until the safety margin, it no longer runs: the coins go straight to the lender's script, and the lender must get that transaction confirmed before the escape height.

**An auction winner who waits.** A winner must request the signature and broadcast. If they wait past the escape height, the owner can take the coins first, and the winner has paid for nothing. The app and the keeper both act at once, and the safety margin is there for this.

**A deposit reorganised away.** A proof needs `confirmations` blocks. Testnet uses 2. A mainnet deployment should use at least 6, since a deep reorganisation after a loan opens would cost the lender.

**A stuck Bitcoin transaction.** The beneficiary can ask for a new signature with a higher fee, capped as a share of the coin. Spends signal replace-by-fee.

## Known limits of this build

- One deposit per vault. A second payment to the address is not counted, but the owner's path can still recover it after the escape height.
- The contract does not watch Bitcoin after signing, so `sats_locked` falls when a spend is signed, not when it confirms.
- Interest is fixed at opening and is not reduced by early repayment.
- `near-sandbox` does not run on Windows, so the integration tests use `tools/sim`, which runs the compiled contracts but does not meter gas. Gas is covered only by real network runs.
