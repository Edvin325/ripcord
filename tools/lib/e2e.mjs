// The real-network run, written against an `env` of services. `e2e-testnet.mjs` passes the
// real ones. `test/e2e-script.test.mjs` passes the simulator, so the script itself is
// rehearsed before it spends scarce testnet NEAR.
//
//   Part 1: lend, lock, prove, borrow, repay, get the coins signed back.
//   Part 2: a default. A keeper starts the auction, a bidder buys, the coins move.
//   Part 3: interest becomes staked NEAR, through a sale with no price feed.
//   Part 4: the ripcord, with a loan still open and no contract call at all.

import {
  addressToScript,
  buildSpend,
  bytesToHex,
  hexToBytes,
  newOwnerKey,
  parseVaultScript,
  signOwnerPath,
  txid as txidOf,
} from './btc-core.mjs';

const USDC = 1_000_000n;
const NEAR = 10n ** 24n;
const SATS_PER_BTC = 100_000_000n;

/** Where a borrower might open an auction: well above a bitcoin's plausible price. */
const OPEN_PER_BTC = 150_000n * USDC;

export async function runE2E(env, { borrower, lender, keeper, sats = 12_000, parts = ['1', '2', '3', '4'] }) {
  const { d, call, view, api, buildProof, pay, explorer, sleep, walletAddress, record } = env;
  const SATS = BigInt(sats);
  const home = bytesToHex(addressToScript('tb', walletAddress));

  const must = (r, step, extra = {}) => {
    record(step, { near_tx: r.hash, ok: r.ok, tgas: r.tgas, ...extra });
    if (!r.ok) throw new Error(`${step}: ${r.failures.join(' | ')}`);
    return r;
  };

  const vault = (id) => view(d.network, d.ripcord, 'get_vault', { vault_id: String(id) });
  const config = () => view(d.network, d.ripcord, 'get_config');
  const clientHeight = () => view(d.network, d.btcClient, 'get_last_block_height');

  async function waitFor(label, check, { everyMs = 30_000, limitMs = 3_600_000 } = {}) {
    const started = Date.now();
    let waited = 0;
    for (;;) {
      const value = await check().catch((e) => {
        console.log(`  (${label}: ${e.message.slice(0, 120)})`);
        return null;
      });
      if (value) return value;
      waited += everyMs;
      if (waited > limitMs || Date.now() - started > limitMs) throw new Error(`gave up waiting for ${label}`);
      console.log(`  waiting for ${label}`);
      await sleep(everyMs);
    }
  }

  const tokenCall = (sender, amount, msg) =>
    call(
      d.network,
      sender,
      d.usdc,
      'ft_transfer_call',
      { receiver_id: d.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) },
      { deposit: 1n },
    );

  /** Registers each account with the test token and hands it test dollars. */
  async function setup() {
    for (const account of [borrower, lender, keeper]) {
      const registered = await view(d.network, d.usdc, 'storage_balance_of', { account_id: account });
      if (!registered) {
        must(await call(d.network, account, d.usdc, 'storage_deposit', {}, { deposit: NEAR / 100n }), `registered ${account}`);
      }
      must(await call(d.network, account, d.usdc, 'faucet', { amount: (2_000n * USDC).toString() }), `test dollars for ${account}`);
    }
  }

  async function makeOffer({ dollars, perBtc, apr, term }) {
    const offer = must(
      await tokenCall(lender, dollars * USDC, {
        offer: {
          micro_usdc_per_btc: (perBtc * USDC).toString(),
          apr_bps: apr,
          term_blocks: term,
          btc_script: home,
        },
      }),
      'lender made an offer',
      { dollars: String(dollars), per_btc: String(perBtc), apr_bps: apr, term_blocks: term },
    );
    return offer.events.find((e) => e.event === 'offer_created').data[0].offer_id;
  }

  async function openVault(blocks) {
    const c = await config();
    const key = newOwnerKey();
    const escape = (await clientHeight()) + blocks;
    const r = must(
      await call(
        d.network,
        borrower,
        d.ripcord,
        'open_vault',
        { owner_pubkey: bytesToHex(key.publicKey), escape_height: escape, expected_sats: SATS.toString() },
        { deposit: BigInt(c.vault_fee) + BigInt(c.vault_storage) },
      ),
      'opened a vault',
    );
    const { vault_id: id, address } = r.events.find((e) => e.event === 'vault_opened').data[0];
    const v = await vault(id);

    // Before sending a coin, confirm what the address enforces.
    const parsed = parseVaultScript(hexToBytes(v.witness_script));
    if (bytesToHex(parsed.ownerPub) !== bytesToHex(key.publicKey) || parsed.escapeHeight !== escape) {
      throw new Error('the script does not match what was asked for');
    }
    record('checked the script', { vault: id, address, escape_height: escape, signer_key: bytesToHex(parsed.signerPub) });
    return { id, address, key, escape };
  }

  async function fundAndProve({ id, address }) {
    const txid = await waitFor('confirmed coins to spend', () => pay(address, Number(SATS)), { limitMs: 1_800_000 });
    record('paid the vault on Bitcoin', { btc_tx: txid, explorer: explorer(txid) });

    const c = await config();
    await waitFor('Bitcoin confirmations seen by the light client', async () => {
      const tx = await api.tx(txid);
      if (!tx.status?.confirmed) return false;
      return (await clientHeight()) - tx.status.block_height + 1 >= c.confirmations;
    });

    const { raw_tx, proof } = await buildProof(api, txid);
    const tx = await api.tx(txid);
    const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === address);
    must(await call(d.network, keeper, d.ripcord, 'prove_deposit', { vault_id: String(id), raw_tx, vout, proof }), 'proved the deposit');
    const v = await vault(id);
    if (v.status !== 'funded') throw new Error(`vault is ${v.status} after the proof`);
    return txid;
  }

  async function borrow(id, offerId, principal, extra = {}) {
    must(
      await call(
        d.network,
        borrower,
        d.ripcord,
        'borrow',
        {
          vault_id: String(id),
          offer_id: offerId,
          principal: principal.toString(),
          auction_open_per_btc: OPEN_PER_BTC.toString(),
          ...extra,
        },
        { deposit: 1n },
      ),
      'borrowed',
    );
    const loan = (await vault(id)).loan;
    record('loan open', {
      principal: loan.principal,
      debt: loan.debt,
      due_height: loan.due_height,
      grace_end_height: loan.grace_end_height,
      auction_start: loan.auction_start,
    });
    return loan;
  }

  /** The signers can be slow and the RPC call can time out, so watch the contract instead. */
  async function signAndBroadcast(id, signer, feeSats) {
    await call(d.network, signer, d.ripcord, 'request_signature', { vault_id: String(id), fee_sats: String(feeSats) }, { deposit: 1n }).then(
      (r) => record('requested an MPC signature', { near_tx: r.hash, ok: r.ok, tgas: r.tgas, failures: r.failures }),
      (e) => record('signature request is still running', { note: e.message.slice(0, 160) }),
    );
    const signed = await waitFor(
      'the MPC signature',
      async () => {
        const v = await vault(id);
        return v.signed_tx ? v : null;
      },
      { everyMs: 10_000, limitMs: 600_000 },
    );
    record('the contract stored a transaction signed by the MPC network', { signed_txid: signed.signed_txid });
    const txid = await api.broadcast(signed.signed_tx);
    record('Bitcoin accepted the contract-signed spend', { btc_tx: txid, explorer: explorer(txid) });
    return txid;
  }

  async function contractPath() {
    record('PART ONE: the contract path');
    // Test dollars, priced absurdly on purpose: a loan this big on a coin this small earns
    // more than the $1 the endowment needs before it can open a sale in part three.
    const offerId = await makeOffer({ dollars: 1_500n, perBtc: 10_000_000n, apr: 100_000, term: 60 });
    // Testnet3 makes blocks in bursts, so leave room: this loan needs 104 blocks to fit.
    const opened = await openVault(150);
    await fundAndProve(opened);

    const loan = await borrow(opened.id, offerId, (SATS * 10_000_000n * USDC) / SATS_PER_BTC);
    must(await call(d.network, borrower, d.ripcord, 'withdraw', {}, { deposit: 1n }), 'borrower withdrew the dollars');
    must(await tokenCall(borrower, loan.debt, { repay: { vault_id: String(opened.id) } }), 'repaid');
    must(
      await call(d.network, borrower, d.ripcord, 'release', { vault_id: String(opened.id), destination: home }, { deposit: 1n }),
      'released the coins',
    );
    await signAndBroadcast(opened.id, borrower, 600);
  }

  async function defaultPath() {
    record('PART TWO: a default, sold at auction');
    const offerId = await makeOffer({ dollars: 100n, perBtc: 40_000n, apr: 900, term: 1 });
    const opened = await openVault(70);
    await fundAndProve(opened);
    const id = String(opened.id);

    const principal = (SATS * 40_000n * USDC) / SATS_PER_BTC / 2n;
    const loan = await borrow(opened.id, offerId, principal, { payout_to: borrower });

    await waitFor('the grace period to end', async () => (await clientHeight()) > loan.grace_end_height, { limitMs: 5_400_000 });
    must(await call(d.network, keeper, d.ripcord, 'start_auction', { vault_id: id }), 'a keeper started the auction');
    const price = BigInt(await view(d.network, d.ripcord, 'auction_price', { vault_id: id }));
    record('the auction is running', { price: price.toString(), floor: loan.debt });

    // A little over the price, because the contract refunds the difference.
    must(await tokenCall(keeper, (price * 101n) / 100n, { bid: { vault_id: id, btc_script: home } }), 'a bidder bought the coins');
    const won = await vault(id);
    if (won.status !== 'settling' || won.settle_reason !== 'AuctionWon') throw new Error(`vault is ${won.status} after the bid`);
    record('the surplus went back to the borrower', {
      paid_near: price.toString(),
      borrower_balance_in_contract: await view(d.network, d.ripcord, 'get_balance', { account_id: borrower }),
    });
    await signAndBroadcast(opened.id, keeper, 600);

    const stats = await view(d.network, d.endowment, 'get_stats');
    record('the keeper was paid from the endowment', { keeper_payments: stats.keeper_payments, paid_near: stats.total_paid_to_keepers });
  }

  async function endowmentPath() {
    record('PART THREE: interest becomes staked NEAR');
    const owed = await view(d.network, d.ripcord, 'get_balance', { account_id: d.endowment });
    record('interest waiting for the endowment', { micro_usdc: owed });
    must(await call(d.network, keeper, d.endowment, 'collect_usdc'), 'collected the interest');
    const held = BigInt(await view(d.network, d.usdc, 'ft_balance_of', { account_id: d.endowment }));
    record('the endowment holds the dollars', { micro_usdc: held.toString() });

    must(await call(d.network, keeper, d.endowment, 'start_sale'), 'opened a sale');
    record('the sale opened', { rate: await view(d.network, d.endowment, 'current_rate') });

    // Half a NEAR per dollar is a sensible rate for test money. No feed says so: a real
    // buyer would decide this for themselves.
    const target = NEAR / 2n / USDC;
    const rate = await waitFor(
      'the sale rate to fall',
      async () => {
        const r = await view(d.network, d.endowment, 'current_rate');
        return r && BigInt(r) <= target ? BigInt(r) : null;
      },
      { everyMs: 20_000, limitMs: 1_500_000 },
    );
    must(await call(d.network, lender, d.endowment, 'buy_usdc', {}, { deposit: held * rate }), 'a buyer paid NEAR for the dollars', {
      rate: rate.toString(),
    });

    must(await call(d.network, keeper, d.endowment, 'stake'), 'staked with a validator');
    const stats = await view(d.network, d.endowment, 'get_stats');
    const onPool = await view(d.network, d.pool, 'get_account_staked_balance', { account_id: d.endowment });
    if (BigInt(stats.principal_staked) === 0n || BigInt(onPool) === 0n) throw new Error('nothing was staked');
    record('the validator pool holds the stake', {
      pool: d.pool,
      staked_on_pool: onPool,
      principal_staked: stats.principal_staked,
      near_from_sales: stats.near_from_sales,
      usdc_sold: stats.usdc_sold,
    });
  }

  async function ripcordPath() {
    record('PART FOUR: the ripcord, with a loan still open');
    const offerId = await makeOffer({ dollars: 20n, perBtc: 40_000n, apr: 900, term: 1 });
    const opened = await openVault(65);
    await fundAndProve(opened);
    await borrow(opened.id, offerId, (SATS * 40_000n * USDC) / SATS_PER_BTC / 2n);
    const v = await vault(opened.id);

    const tx = buildSpend({
      txid: v.deposit.txid,
      vout: v.deposit.vout,
      value: Number(v.deposit.sats),
      destination: hexToBytes(home),
      feeSats: 600,
      lockTime: v.escape_height,
    });
    const ticket = bytesToHex(signOwnerPath(tx, hexToBytes(v.witness_script), Number(v.deposit.sats), opened.key.secret));
    record('signed the escape ticket', { txid: txidOf(tx), valid_after_block: v.escape_height, loan_status: v.status });

    const tip = await api.tip();
    if (tip < v.escape_height) {
      const early = await api.broadcast(ticket).then(
        (id) => ({ accepted: id }),
        (e) => ({ refused: e.message }),
      );
      record('tried the ticket early', { tip, ...early });
      if (early.accepted) throw new Error('Bitcoin accepted the ticket early');
    }

    const accepted = await waitFor(
      'the escape height',
      async () => {
        if ((await api.tip()) < v.escape_height) return false;
        return api.broadcast(ticket);
      },
      { limitMs: 7_200_000 },
    );
    record('Bitcoin accepted the escape ticket, with no contract call', { btc_tx: accepted, explorer: explorer(accepted) });
  }

  record('start', { wallet: walletAddress, parts });
  await setup();
  if (parts.includes('1')) await contractPath();
  if (parts.includes('2')) await defaultPath();
  if (parts.includes('3')) await endowmentPath();
  if (parts.includes('4')) await ripcordPath();
  record('done');
}
