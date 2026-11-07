# Ripcord

**Borrow dollars against real Bitcoin that never leaves Bitcoin. No bridge, no oracle, no liquidation, and a Bitcoin timelock that returns your coins if NEAR ever stops.**

Built at NEAR HACKATHON for the Unstoppable DeFi track (`defi`). Unaudited.

## What this is

A borrower locks native BTC in a Bitcoin address built for that loan. The address is a small Bitcoin script with two ways to spend:

```text
OP_IF
    <contract key> OP_CHECKSIG                      lock 1: a NEAR contract, through Chain Signatures
OP_ELSE
    <escape height> OP_CHECKLOCKTIMEVERIFY OP_DROP
    <owner key> OP_CHECKSIG                         lock 2: the borrower alone, after that block
OP_ENDIF
```

A NEAR contract proves the deposit through the Bitcoin light client on NEAR, lends USDC from a lender's fixed offer, and signs the coins back when the loan is repaid. If it is not repaid, a Dutch auction sells them, with no price feed. The lender is paid first and the surplus goes back to the borrower.

Lock 2 is the ripcord. Bitcoin enforces it, so it still works if this website, 1Click, the signers or NEAR itself stop.

## The problem

Borrowing against Bitcoin today means handing it to a custodian or a bridge, then trusting a price feed not to liquidate you in a dip. Every "unstoppable" lending app still has a switch somewhere.

## Try it

Steps 1 to 3 need nothing but Node 20 or newer.

**1. Run the test suite against the compiled contracts.**

```bash
cd tools
npm install
npm test
```

You see `tests 60`, `pass 60`. This runs the real wasm in `target/near/` inside a small NEAR runtime, `tools/sim`. Its Bitcoin checks the vault's hash commitment, signatures, low-S rule and timelock, so a pass means a spend was accepted. If `target/near/` is missing, build it with step 6.

**2. Watch the whole story in a terminal.**

```bash
node demo.mjs
```

You see a repaid loan, a default sold at auction with the surplus returned, and the ripcord: NEAR is switched off, Bitcoin refuses the escape ticket early and accepts it on time. The last lines show what the endowment staked.

**3. Get live cross-chain prices.**

```bash
node quotes.mjs
```

You see real NEAR Intents quotes for paying a loan out to Base, Arbitrum, Solana and Ethereum, repaying from each, and selling BTC for USDC. They are `dry` quotes from the real 1Click API, so nothing moves.

**4. Use the app with no wallet.**

```bash
cd ../app
npm install
npm run dev
```

Open http://localhost:4173. The Simulator runs the real contracts in your browser tab.

- Click **Try to switch it off**, then **Pull the ripcord**. You see a loan open, a 50% crash change nothing, every dependency switch off, Bitcoin refuse the ticket, then accept it.
- Click **Borrow**, then **Open vault**, and follow the steps. You see a live NEAR Intents price under **Deliver the dollars to**.
- Press **Crash 50%** in the bottom bar during a loan. You see nothing happen to it.

**5. Check the Bitcoin code against the spec.**

```bash
cargo test -p near-btc-script -p ripcord-core
```

You see 65 tests pass. They include the BIP-143 vectors, real mainnet transactions including Satoshi's payment to Hal Finney, and byte-for-byte agreement with bitcoinjs-lib on both spending paths.

**6. Build the contracts.**

```bash
cargo install cargo-near
cd contracts/ripcord
cargo near build non-reproducible-wasm --no-abi
```

Repeat in `contracts/endowment` and `contracts/test-usdc`. The output lands in `target/near/`.

## Status

| Part | State |
| --- | --- |
| Bitcoin library | Done. Tested against BIP vectors, real transactions and bitcoinjs-lib |
| Contracts | Built. All 60 lifecycle tests pass on the compiled wasm |
| Web app | Works in the simulator. Checked in a real browser with `app/scripts/ui-check.mjs` |
| Light client and MPC | Tested live with read-only calls, on testnet and mainnet |
| NEAR Intents | Live `dry` quotes work. Intents has no testnet, so payouts on testnet stay on NEAR |
| A full loan on real networks | **Not done yet** |

## Why NEAR

One contract can verify Bitcoin history through the light client, sign real Bitcoin transactions through Chain Signatures, and pay out on any chain through NEAR Intents. Other routes need a new validator set, a custodian or wrapped coins.

| NEAR feature | Use here |
| --- | --- |
| Chain Signatures | The contract signs each vault's Bitcoin spend. Each vault has its own derived key |
| Bitcoin light client | Proves deposits. No relayer is trusted |
| NEAR Intents | Pays out to any chain, repays from any chain, and prices BTC sales |
| Staking | The endowment stakes every fee with a validator |

## What NEAR gets

Ripcord has no team, no token and no treasury key. A keyless endowment pays for its upkeep instead:

1. **Staked NEAR that never leaves.** Each vault pays a flat fee in NEAR, and a share of all interest is sold for NEAR in a Dutch auction with no price feed. All of it is staked with a validator, and only rewards can ever come out. Rewards pay keepers.
2. **Volume through Intents.** Payouts and repayments can cross chains through NEAR Intents, and that flow reaches the fee switch that buys back NEAR.
3. **Native Bitcoin under NEAR's rules.** Coins stay on Bitcoin but follow a NEAR contract, with nothing wrapped.
4. **An open kit for builders.** `crates/near-btc-script` has no dependencies. Any NEAR contract can use it to hold native Bitcoin under script rules.
5. **Findings.** `docs/FINDINGS-FOR-NEAR.md` lists what we learned testing live contracts, including gaps in the docs.

## Why a lender would do this

With no liquidation, a lender's result depends only on the price at the due date. `research/lender-backtest.mjs` replays every start day since 2013 from a saved price file.

| LTV | Term | Ends underwater | Break-even APR | Hit an 80% price trigger | Hit it, yet recovered |
| --- | --- | --- | --- | --- | --- |
| 40% | 30 days | 0.00% | 0.00% | 0.60% | 0.60% |
| 50% | 30 days | 0.12% | 0.09% | 3.40% | 3.28% |
| 60% | 30 days | 0.80% | 0.86% | 10.30% | 9.50% |
| 70% | 30 days | 2.84% | 3.63% | 32.45% | 29.61% |

At 50% LTV for 30 days, a 9% loan pays about 100 times its historical break-even rate. The last column is borrowers who would lose their position to a price trigger on another platform, and keep it here.

These use daily average prices, which hide intraday wicks, and past prices do not predict future ones. See `research/lender-backtest.md` for the full tables.

## What can go wrong

`docs/THREAT-MODEL.md` has all of it. The most important limits:

- **Signers.** The ripcord protects you if NEAR's signers go **offline**, not if a majority turns **malicious**. That is the same trust as every Chain Signatures product.
- **Lenders can lose.** A lender can end up with Bitcoin worth less than the loan, and prices that into the offer.
- **Unaudited.** Do not use real money you cannot lose.

## Repository

| Path | What it is |
| --- | --- |
| `crates/near-btc-script` | Bitcoin script, sighash, parsing and signature encoding. No dependencies |
| `crates/ripcord-core` | Every loan rule as a pure function, with sweeps over generated inputs |
| `contracts/ripcord` | The lending contract |
| `contracts/endowment` | Stakes fees and sells interest for NEAR |
| `contracts/test-usdc` | Testnet token with a faucet |
| `tools/sim` | A NEAR runtime in JavaScript that runs the compiled contracts |
| `tools/ripcord.mjs` | Every action from the command line |
| `tools/keeper.mjs` | A permissionless keeper. Anyone can run one |
| `tools/escape.mjs` | Signs the owner's exit offline, with no network |
| `app` | The web app |
| `research` | The lender backtest, with its data |

## Hackathon notes

- **All work is new**, started on 7 Nov 2026, inside the window.
- **Libraries:** near-sdk, near-contract-standards, near-api-js, @noble/curves, @noble/hashes, bitcoinjs-lib (tests only), preact, vite, @hot-labs/near-connect, playwright-core (tests only). Fonts: Barlow Condensed and IBM Plex, under the SIL Open Font License.
- **AI tools:** written with Claude Code.
- **License:** MIT.
