# Ripcord

**Borrow dollars against real Bitcoin that never leaves Bitcoin. No bridge, no oracle, no liquidation, and a Bitcoin timelock that returns your coins if NEAR ever stops.**

Built at NEAR HACKATHON for the Unstoppable DeFi track (`defi`). Unaudited.

## Watch it

- **Demo, 2:17, with a voice:** [play in the browser](https://edvin325.github.io/ripcord/media/ripcord-demo.mp4) or [the file](media/ripcord-demo.mp4). The real app: open a vault, borrow, survive a 50% crash, switch everything off and get the coins back through Bitcoin alone. It ends on the real Bitcoin testnet spend a NEAR contract signed.
- **Explainer, 2:15, in plain words:** [play in the browser](https://edvin325.github.io/ripcord/media/ripcord-explained.mp4) or [the file](media/ripcord-explained.mp4). The problem and the fix, with drawings and no technical terms.
- **Hosted app:** https://edvin325.github.io/ripcord/ runs the real compiled contracts in your browser, with no wallet.

`app/scripts/record-demo.mjs` and `app/scripts/record-explainer.mjs` record both videos from this repository.

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

A NEAR contract proves the deposit through the Bitcoin light client on NEAR, lends USDC from a lender's fixed offer, and signs the coins back when the loan is repaid. If it is not repaid, a Dutch auction sells them with no price feed, falling from an opening price the borrower named to the debt. The lender is paid first and the surplus goes back to the borrower.

Lock 2 is the ripcord. Bitcoin enforces it, so it still works if this website, 1Click, the signers or NEAR itself stop.

## The problem

Borrowing against Bitcoin today means handing it to a custodian or a bridge, then trusting a price feed not to liquidate you in a dip. Every "unstoppable" lending app still has a switch somewhere.

## Try it

Steps 1 to 3 need nothing but Node 20.19 or newer. They were run from a fresh clone on Node 20, 22, 24 and 26.

**1. Run the test suite against the compiled contracts.**

```bash
cd tools
npm install
npm test
```

You see `tests 99`, `pass 99`. This runs the compiled contracts from `contracts/wasm` inside a small NEAR runtime, `tools/sim`. Its Bitcoin checks the vault's hash commitment, signatures, low-S rule and timelock, so a pass means a spend was accepted. A fresh build in `target/near` takes priority if there is one.

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

Open http://localhost:4173, or skip the install and open the hosted copy at https://edvin325.github.io/ripcord/. The Simulator runs the real contracts in your browser tab.

- Click **Try to switch it off**, then **Pull the ripcord**. You see a loan open, a 50% crash change nothing, every dependency switch off, Bitcoin refuse the ticket, then accept it.
- Click **Borrow**, then **Open vault**, and follow the steps. Pick Base under **Deliver the dollars to** and enter a Base address. You see a live NEAR Intents price. Press **Borrow and send to Base**, and you see the transfer move through 1Click's statuses to **Delivered on Base**, with **Where your money is** saying where the dollars are at each step. Intents has no testnet, so the delivery is simulated and says so. The price is real.
- Set **Intents** in the bottom bar to **Refunds** or **Fails** and borrow again. You see a refunded transfer put the dollars back in your NEAR account, and a failed one say what to keep.
- Under the loan, pick Base under **Repay from**. You see a deposit address and the exact amount to send, then the dollars arrive on NEAR and you repay.
- Click **History**. You see every step you took, newest first. On testnet each one links to a block explorer.
- Press **Crash 50%** in the bottom bar during a loan. You see nothing happen to it.

**5. Check the Bitcoin code against the spec.**

```bash
cargo test -p near-btc-script -p ripcord-core
```

You see 76 tests pass. They include the BIP-143 vectors, real mainnet transactions including Satoshi's payment to Hal Finney, and byte-for-byte agreement with bitcoinjs-lib on both spending paths.

**6. Build the contracts.**

```bash
cargo install cargo-near
cd contracts/ripcord
cargo near build non-reproducible-wasm --no-abi
```

Repeat in `contracts/endowment` and `contracts/test-usdc`. The output lands in `target/near/`.

**7. Check that the tests can fail.**

```bash
cd tools
node mutation-check.mjs
```

This undoes each security fix in turn, rebuilds the real contract and confirms the matching test goes red. You see `16 of 16 fixes are guarded`. The last run is in `evidence/mutation-check.json`.

**8. Check the NEAR Intents code against the real 1Click API, with no money.**

```bash
cd tools
node intents-check.mjs
```

You see the live token list confirm all four USDC routes, a dry quote, and two committed quotes: one gives a NEAR deposit address for a loan going out, one gives a Base deposit address for a repayment coming in. Both show `PENDING_DEPOSIT`. Nothing is ever sent to them. The last run is in `evidence/intents-api-check.json`.

## Proven on real networks

These ran on NEAR testnet and Bitcoin testnet3, with the real MPC signers and the real light client. Every hash is in `evidence/`, so you can look each one up. They ran before the security fixes in `docs/THREAT-MODEL.md`. The Bitcoin script has not changed since, but the contracts have.

**Lock 1: a NEAR contract spent native Bitcoin.** The compiled contract got its vault key from the MPC network, proved a real deposit through the light client, had the signers sign in 8 seconds, and stored the finished transaction. Bitcoin accepted it.

- Spend: [30f9bbf3…7d3c](https://mempool.space/testnet/tx/30f9bbf37bc8dcfe9c08238252fb8c9c7ae19cc6c269ca303691e003e5f97d3c), confirmed in block 5,302,906. The witness selector `01` shows lock 1.
- Reproduce with `node tools/spike-contract.mjs <funded account>`. It needs about 3.1 testnet NEAR and some test Bitcoin.

**Lock 2: Bitcoin alone enforced the escape.** A real node refused the owner's transaction before its block with `{"code":-26,"message":"non-final"}`, then accepted it at that block, with no contract call.

- Spend: [20c415dc…3047](https://mempool.space/testnet/tx/20c415dc01e777500e1c85dd7dfc0b1fc037c08c2a8f65685b7c4f6b93323047). The empty witness selector shows lock 2.
- The live light client also checked this vault's deposit: the real proof returned `true`, and the same proof with a forged txid returned `false`.
- Reproduce with `node tools/prove-script.mjs`. It needs some test Bitcoin and no NEAR tokens.

## Status

| Part | State |
| --- | --- |
| Bitcoin library | Done. Tested against BIP vectors, real transactions and bitcoinjs-lib |
| Contracts | Built. All 99 tests pass on the compiled wasm, and an AI review's findings are fixed |
| Vault, deposit proof, MPC signing, Bitcoin spend | **Done on real networks**, for both locks |
| Web app | Works in the simulator. Checked in a real browser with `app/scripts/ui-check.mjs` |
| NEAR Intents | Built: loans paid out to Base, Arbitrum, Solana or Ethereum, and repayments brought in from them, through the 1Click API, with every status shown, including refunds and failures. Checked against the real API with no money moved, and run end to end on the compiled contracts against a simulated 1Click. **Not yet run with real money**: Intents has no testnet, so that needs a mainnet run, which waits for approval (`tools/intents-payout.mjs`) |
| A loan with USDC on real networks | **Not done yet.** So far this has only run in the simulator |
| The endowment on real networks | **Not done yet.** So far this has only run in the simulator |

## The DeFi track prompt, point by point

The track's example prompt asks for these. Its starter idea is a DCA vault, so where Ripcord is a loan instead, the closest equivalent is given.

| The prompt asks for | Where it is |
| --- | --- |
| No custodian, nobody who can switch it off | The coins stay in a Bitcoin script nobody holds, and lock 2 needs nothing but Bitcoin. Proven on real Bitcoin testnet |
| The 1Click API for quotes, deposits and status tracking | `tools/lib/oneclick.mjs`, in the order the `near-intents` skill gives. Checked against the real API by `tools/intents-check.mjs` |
| REFUNDED and FAILED shown in the UI | The transfer card and **Where your money is**, for every 1Click status. Set **Intents** to **Refunds** or **Fails** in the simulator to see them |
| Show the user where their funds sit at every step | **Where your money is** on each vault: the Bitcoin, the borrowed dollars, the debt, and anything waiting in the contract |
| A web UI with deposit, schedule and a history with explorer links | Deposit on each vault, a **Schedule** table of the blocks that matter, and **History**, with explorer links on testnet and mainnet |
| A dry-run mode with real quotes and no funds | The simulator runs the real compiled contracts with live 1Click prices, and needs no wallet or funds |
| Stretch: a NEAR contract owns the vault and controls a derived BTC address through Chain Signatures | That is Ripcord's core. Each vault's key is derived for the contract, and a real spend was signed on Bitcoin testnet |
| Settle across chains through NEAR Intents | Built and tested as above. A real transfer with real money waits for a mainnet run |

## Why NEAR

One contract can verify Bitcoin history through the light client, sign real Bitcoin transactions through Chain Signatures, and reach any chain through NEAR Intents. Other routes need a new validator set, a custodian or wrapped coins.

| NEAR feature | Use here |
| --- | --- |
| Chain Signatures | The contract signs each vault's Bitcoin spend. Each vault has its own derived key |
| Bitcoin light client | Proves deposits. No relayer is trusted |
| NEAR Intents | Pays loans out to other chains and brings repayments in, through the 1Click API. See Status for what has run with real money |
| Staking | The endowment stakes every fee with a validator |

## What NEAR gets

Ripcord has no team, no token and no treasury key. A keyless endowment pays for its upkeep instead:

1. **Staked NEAR that never leaves.** Each vault pays a flat fee in NEAR, and a share of all interest is sold for NEAR in a Dutch auction with no price feed. All of it is staked with a validator, and only rewards can ever come out. Rewards pay keepers.
2. **Volume through Intents.** Payouts and repayments are built to cross chains through NEAR Intents, and on mainnet that flow would reach the fee switch that buys back NEAR.
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
- **Borrowers can lose their surplus.** If nobody starts the auction in time, the lender takes the coins. If the opening price is set too low, a bot can buy them cheaply.
- **Unaudited.** It has had an AI code review, not a professional audit. Do not use real money you cannot lose.

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
| `tools/verify.mjs` | Checks a live deployment against this repository, with no key or wallet |
| `tools/mutation-check.mjs` | Proves the tests can fail, by undoing each fix |
| `tools/lib/oneclick.mjs` | The 1Click API: tokens, quotes, deposit notices, status, and plain words for each status |
| `tools/sim/intents.mjs` | A simulated 1Click, so transfers can be tried and tested without a testnet |
| `tools/intents-check.mjs` | Checks the Intents code against the real API, moving no money |
| `tools/intents-payout.mjs` | A real mainnet transfer. Runs only with `--yes` and a human's approval |
| `tools/escape.mjs` | Signs the owner's exit offline, with no network |
| `app` | The web app |
| `app/scripts` | The browser check and the two video recorders |
| `media` | The demo and explainer videos |
| `research` | The lender backtest, with its data |

## Hackathon notes

- **All work is new**, started on 7 Nov 2026, inside the window.
- **Libraries:** near-sdk, near-contract-standards, near-api-js, @noble/curves, @noble/hashes, bitcoinjs-lib, ecpair and tiny-secp256k1 (tests and the test wallet), preact, @preact/preset-vite, vite, @hot-labs/near-connect, playwright-core (browser check and video). Fonts: Barlow Condensed and IBM Plex through @fontsource, under the SIL Open Font License.
- **Videos:** recorded from the real app with playwright-core, narrated by the Windows voice Microsoft Heera, and encoded with ffmpeg.
- **AI tools:** written with Claude Code. The NEAR Intents code follows NEAR's `near-intents` agent skill from github.com/near/agent-skills, read as documentation.
- **License:** MIT.
