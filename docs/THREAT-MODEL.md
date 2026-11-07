# Threat model

This is what Ripcord protects against, what it does not, and who carries each risk. It is unaudited hackathon software.

## Who has to be trusted

| Party | Trusted for | If they fail |
| --- | --- | --- |
| Bitcoin | Enforcing the script | Nothing here survives that |
| NEAR's MPC signers | Honestly signing only what the contract asks | See "A colluding signer majority" |
| NEAR validators | Running the contract correctly | See "NEAR stops" |
| Bitcoin light client relayers | Keeping headers current. They cannot forge history: headers carry proof of work | New deposits cannot be proven, and new loans and auctions wait until it catches up. Repaying is not affected |
| Ripcord's authors | Nothing, once the contract's keys are removed | There is no admin method |

## What it protects against

**A dip.** There is no price anywhere in the contract, so no price can trigger anything. `crates/ripcord-core` has no price input.

**A stale or manipulated oracle.** There is no oracle. The BTC price stored in `pyth-oracle.near` was about 73 days old on 7 Nov 2026. Pyth is pull-based, so an app can push updates, but a protocol built on a price inherits that dependency.

**NEAR stops, or the signers go offline.** The owner's Bitcoin script path opens at the escape height and needs nothing but the owner's key. The escape ticket is a transaction signed in advance, so even the key is not needed on the day.

**This website or our relayer disappears.** Every action is an ordinary contract call. `tools/ripcord.mjs` and `tools/keeper.mjs` do the same work, and anyone can run them.

**A forged deposit.** The contract computes the txid from the raw transaction itself, reads the amount from the output, and has the light client check the proof. Changing the amount changes the txid. The light client's coinbase proof closes the 64-byte transaction forgery, and the parser refuses 64-byte transactions too.

**A griefing deposit.** Proofs are open to anyone. A vault states the smallest deposit it accepts, so blocking one means gifting that much.

**A leaked app key.** `borrow`, `withdraw`, `release`, `request_signature`, `cancel_offer` and `abandon_vault` need one yoctoNEAR, so a function-call key cannot use them.

**A broken lender account.** Payments are pulled, not pushed, so a lender who cannot receive tokens cannot make a repayment fail.

**A bad signature.** The contract recovers the signer from every MPC response and refuses one that does not match the vault's key.

**A frozen light client.** If its relayer stops, the height the contract reads stands still while Bitcoin moves on, and every check against the escape height becomes too generous. `borrow` and `start_auction` refuse a header older than `max_tip_age_seconds`. That limit, plus the two hours Bitcoin lets miners stamp a header ahead, must fit inside the safety margin, or the contract refuses to initialise. Repaying never reads the light client, so a stale one cannot stop a borrower from paying.

**A cheap grab of a small loan's coins.** With no price feed, the contract cannot know what the coins are worth. So the borrower names the auction's opening price when they borrow, and it falls from there to the debt. The app suggests three times today's price. The rules never let it open below three times the debt.

**A buyer walking the endowment's sale down.** Every sale opens at the same high rate and halves on the same schedule, and nothing carries over from the last one. Buying a little at the bottom of one sale does nothing to the next.

**Two calls at once.** On NEAR a callback runs after its call, so state can change in between. Every callback that commits something checks the state again. The tests send competing calls together so their receipts really do interleave.

## What it does not protect against

**A colluding signer majority.** If enough MPC operators collude, they can spend lock 1 before the escape height. The ripcord protects against signers being **offline**, not **malicious**. This is the same trust as nBTC and every other Chain Signatures product. The ripcord adds a way out of a shutdown, not a defence against theft by the network.

**A bug in the contract.** Once its keys are removed, nothing can patch it. It has had no audit.

**A lender's price risk.** A lender can end up with Bitcoin worth less than the loan. That is the trade for having no liquidation, and `research/lender-backtest.md` shows how often it would have happened.

**Losing the key and the ticket.** If you lose both, and NEAR has stopped, the coins are gone. While NEAR runs, the contract can still release them.

## Races worth knowing about

**The escape height and the lender.** After the escape height the owner can take the coins, even with a loan unpaid. `open_loan` refuses any loan whose due date, grace, start window, auction and safety margin do not all fit before that height, so a lender always has time to act. If nobody acts in that whole window, the lender can lose the collateral.

**Starting too late.** Every loan leaves at least `start_window_blocks` in which anyone can start the auction, and a keeper earns a bounty for doing it. If nobody does, it no longer runs: the coins go straight to the lender's script, the borrower loses any surplus, and the lender must get that transaction confirmed before the escape height.

**An auction winner who waits.** A winner must request the signature and broadcast. If they wait past the escape height, the owner can take the coins first, and the winner has paid for nothing. The app and the keeper both act at once, and the safety margin is there for this.

**A deposit reorganised away.** A proof needs `confirmations` blocks. Testnet uses 2. A mainnet deployment should use at least 6, since a deep reorganisation after a loan opens would cost the lender.

**A stuck Bitcoin transaction.** The beneficiary can ask for a new signature with a higher fee, capped as a share of the coin. Spends signal replace-by-fee.

## Known limits of this build

- One deposit per vault. A second payment to the address is not counted, but the owner's path can still recover it after the escape height.
- A far too high auction opening price leaves bidders little time near the real price, which can cost the borrower their surplus. It cannot hurt the lender.
- Nobody pays storage for an offer or a balance. Empty ones are deleted, and each open offer ties up at least $10, but a well-funded attacker could still use up a contract's spare storage. Anyone can fix that with a plain NEAR transfer.
- The freshness check trusts the miner's timestamp, within Bitcoin's two-hour limit. The safety margin is sized to absorb that. The check assumes Bitcoin runs at no more than twice its usual speed, which holds on mainnet and not on testnet3.
- The contract does not watch Bitcoin after signing, so `sats_locked` falls when a spend is signed, not when it confirms.
- Interest is fixed at opening and is not reduced by early repayment.
- Repaying through Intents is priced but not wired up. A 1Click delivery with `customRecipientMsg` arrives from `intents.near`, not the payer, and that feature is marked highly experimental, so a refused payment would need care. Direct repayment does not have this problem.
- `near-sandbox` does not run on Windows, so the integration tests use `tools/sim`, which runs the compiled contracts but does not meter gas. Gas is covered only by real network runs.

## How this was reviewed

This has had an AI code review, not a professional audit. That review found the problems below in an earlier build, and all of them are fixed.

| Severity | What was wrong | The fix |
| --- | --- | --- |
| High | The auction opened at three times the debt, so a small loan on a big coin could lose the coin for far less than it was worth | The borrower names the opening price |
| High | A loan that only just fit had no blocks in which to start its auction, so a default skipped the auction and the surplus | A start window is part of the timeline a loan must fit |
| High | Each endowment sale opened near the last fill, so a small buyer could walk the price down, sale after sale | Sales open at a fixed rate and carry nothing over |
| Medium | A frozen light client could pass the timeline check on old numbers | `borrow` and `start_auction` refuse a stale header |
| Medium | NEAR waiting to be refunded to a buyer could be staked | It is held back until the purchase settles |
| Medium | Anyone could keep restarting the pool's unstaking wait, locking rewards for good | Harvests are five epochs apart |
| Medium | Closed offers and empty balances stayed in storage that nobody paid for | They are deleted |
| Medium | Anyone could call `new` between the deploy and the init | Initialising is private |
| Low | Two sale starts in flight, a failed last transfer, a vault stuck waiting for its key, a signature with no full-access key, lists cut off at the first page, and params that could never work | Each is fixed |

Every fix has a test. `tools/mutation-check.mjs` undoes each fix in turn, rebuilds the real contract and confirms the test goes red, because a test that cannot fail proves nothing. The result is in `evidence/mutation-check.json`.
