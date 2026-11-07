// A rehearsal of the real-network run. Testnet NEAR is scarce and a real run takes hours, so
// the script is run here first, with the deployment's own settings, on the compiled
// contracts. This proves the script is right. It does not prove anything about the real
// networks: only evidence/testnet-run.json does that.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNTS as A, addressOf, p2wpkhOf } from '../sim/world.mjs';
import { nodeWorld } from '../sim/node-world.mjs';
import { addressToScript } from '../lib/btc-core.mjs';
import { runE2E } from '../lib/e2e.mjs';
import { KEEPER_BOUNTY, KEEPER_FLOAT, PARAMS, SALE, VAULT_FEE } from '../lib/testnet-params.mjs';

function rehearsal() {
  const w = nodeWorld({ params: PARAMS, sale: SALE, vaultFee: VAULT_FEE, keeperBounty: KEEPER_BOUNTY, keeperFloat: KEEPER_FLOAT });
  const steps = [];
  const walletAddress = addressOf(p2wpkhOf(0xee));

  const env = {
    d: {
      network: 'sim',
      btcNetwork: 'testnet3',
      ripcord: A.ripcord,
      usdc: A.usdc,
      endowment: A.endowment,
      pool: A.pool,
      btcClient: A.client,
    },
    call: async (_network, signer, contract, method, args, options) => {
      const r = w.near.call(signer, contract, method, args, options);
      // The real client counts a failure in any receipt, not only the last one.
      return { ...r, ok: r.ok && r.failures.length === 0, hash: 'simulated' };
    },
    view: async (_network, contract, method, args) => w.near.view(contract, method, args),
    api: {
      tip: async () => w.bitcoin.height,
      tx: async (id) => {
        const tx = w.bitcoin.txs.get(id);
        return {
          status: { confirmed: Boolean(tx.block), block_height: tx.block?.height, block_hash: tx.block?.hash },
          vout: tx.outputs.map((o) => ({ scriptpubkey_address: addressOf(o.script) })),
        };
      },
      broadcast: async (hex) => w.bitcoin.submit(hex),
    },
    buildProof: async (_api, txid) => w.bitcoin.proofFor(txid),
    pay: async (address, sats) => w.bitcoin.fund(addressToScript('tb', address), sats).txid,
    explorer: (txid) => txid,
    // Waiting is the only thing that moves the simulated clock and chain.
    sleep: async (ms) => {
      w.near.advance(Math.ceil(ms / 1000));
      w.bitcoin.mine(1);
    },
    walletAddress,
    record: (step, detail = {}) => steps.push({ step, ...detail }),
  };

  return { w, env, steps, walletAddress };
}

test('the real-network script runs from start to finish against the compiled contracts', async () => {
  const { w, env, steps, walletAddress } = rehearsal();
  await runE2E(env, { borrower: A.borrower, lender: A.lender, keeper: A.keeper });
  w.bitcoin.mine(1);

  const names = steps.map((s) => s.step);
  for (const part of ['PART ONE', 'PART TWO', 'PART THREE', 'PART FOUR']) {
    assert.ok(names.some((n) => n.startsWith(part)), part);
  }
  assert.equal(names.at(-1), 'done');

  // Three spends came home to the wallet: released, then won at auction, and the ripcord
  // pays the same wallet.
  const home = w.bitcoin.balanceOf(addressToScript('tb', walletAddress));
  assert.equal(home, 3n * 12_000n - 600n * 3n);

  const refused = steps.find((s) => s.step === 'tried the ticket early');
  assert.match(refused.refused, /lock time has not passed/);

  const stats = w.near.view(A.ripcord, 'get_stats');
  assert.equal(stats.loans_opened, 3);
  assert.equal(stats.loans_repaid, 1);
  assert.equal(stats.auctions_won, 1);

  const endowment = w.near.view(A.endowment, 'get_stats');
  assert.equal(endowment.keeper_payments, 1);
  assert.ok(BigInt(endowment.near_from_sales) > 0n);
  assert.ok(BigInt(endowment.principal_staked) >= BigInt(endowment.near_from_sales), 'the sale reached the validator');
});

test('the interest in part one is enough for the endowment to open a sale', async () => {
  const { w, env } = rehearsal();
  await runE2E(env, { borrower: A.borrower, lender: A.lender, keeper: A.keeper, parts: ['1'] });
  assert.ok(BigInt(w.near.view(A.ripcord, 'get_balance', { account_id: A.endowment })) >= 1_000_000n);
});

test('parts can run on their own, to resume a run that stopped', async () => {
  const { env, steps } = rehearsal();
  await runE2E(env, { borrower: A.borrower, lender: A.lender, keeper: A.keeper, parts: ['4'] });
  assert.ok(steps.some((s) => s.step === 'Bitcoin accepted the escape ticket, with no contract call'));
});
