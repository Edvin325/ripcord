# Findings for NEAR builders

Things learned by testing live contracts while building this, on 7 Nov 2026. Each was checked by a direct call, so re-check before relying on it.

## The Bitcoin light client is usable from any contract

`btc-client.bridge.near` on mainnet and `btc-client-v4.testnet` on testnet both tracked the real Bitcoin tip. `verify_transaction_inclusion_v2` is public, takes borsh arguments and returns a boolean.

- A real transaction with a real Merkle proof returned `true` on both networks.
- The same proof with a forged txid returned `false` on both.

This makes Bitcoin history readable from a contract without bridging anything. We found no other hackathon entry using it, and few docs mention it. A worked example would help other builders. `crates/near-btc-script` and `tools/lib/esplora.mjs` are one.

Things that took time to find:

- The testnet client follows Bitcoin **testnet3**, not testnet4, even though the Chain Signatures docs use testnet4 in their examples. Testnet3 is no longer in Bitcoin Core and faucets are drying up. A testnet4 or signet client would help.
- `H256` values are internal byte order in borsh and reversed in JSON.
- `verify_transaction_inclusion_with_heights` exists on testnet but not on mainnet.

## Chain Signatures is no longer one way

The docs say Chain Signatures is a "one way" solution for outbound transactions. The MPC contract now has `verify_foreign_transaction`, and `get_available_foreign_chains` listed these on both networks: Solana, Base, Bnb, Arbitrum, Abstract, Starknet, Polygon, HyperEvm, Aptos, Sui, Avalanche and Fogo.

A contract can now read those chains through the same network that signs for it, which opens designs that were not possible before. It deserves a docs page.

**Bitcoin is not on that list**, although the contract interface and the inspector both support it. The mainnet provider list has a single public Bitcoin provider with a quorum of 1, so it looks close. With it, a contract could prove Bitcoin transactions with no light client at all.

## 1Click

- A quote naming a NEAR account that does not exist fails with `Internal server error`, the same words as a real outage. A clearer message would save time.
- Burn addresses are refused with `recipient is not valid`, which is sensible.
- CORS is open, so a static page can fetch live quotes with no server. That is very useful for apps with no backend.
- `customRecipientMsg` makes one-deposit repayment to a contract possible, and is marked highly experimental. A stable version would let contracts accept any-chain payments directly.

## Oracles

On that date `pyth-oracle.near` held a BTC price about 73 days old, and `price-oracle.near` and `pyth-oracle.testnet` returned nothing for the BTC feed. Pyth is pull-based, so this is expected if nobody pushes updates, but a new builder reading a stored price would get a stale one with no warning unless they use the checked getters.

## Tooling on Windows

- `near-sandbox` has no Windows build. `tools/sim` here is a small runtime in JavaScript that runs compiled contracts with receipts, callbacks and per-receipt rollback, and could be useful to others on Windows.
- The faucet at `helper.nearprotocol.com` limits by IP, so a team on one connection runs out quickly.
