// The simulator backend. It runs the real compiled contracts in this browser tab, against
// a Bitcoin that enforces the vault's signature and timelock rules. No wallet, no tokens
// and no network, so anyone can run a whole loan, then switch things off and see what
// still works.

import { ACCOUNTS, createWorld, USDC } from '@tools/sim/world.mjs';
import { addressToScript, bytesToHex, encodeSegwit, hexToBytes, p2wshScriptPubkey } from '@tools/lib/btc-core.mjs';

const A = ACCOUNTS;

const PARAMS = {
  min_collateral_sats: 10_000,
  grace_blocks: 3,
  auction_seconds: 3_600,
  auction_blocks: 6,
  safety_blocks: 6,
  auction_start_bps: 30_000,
  flywheel_share_bps: 1_000,
  max_btc_fee_bps: 500,
};

/** Named test addresses, so the Bitcoin side reads like people rather than hashes. */
const addressFor = (byte) => encodeSegwit('tb', 0, new Uint8Array(20).fill(byte));

export const ROLES = [
  { id: A.borrower, label: 'Borrower', btc: addressFor(0xb0) },
  { id: A.lender, label: 'Lender', btc: addressFor(0x1e) },
  { id: A.bidder, label: 'Bidder', btc: addressFor(0xbd) },
  { id: A.keeper, label: 'Keeper', btc: addressFor(0xee) },
];

async function loadContracts() {
  const url = (name) => new URL(`wasm/${name}.wasm`, document.baseURI);
  const get = async (name) => new Uint8Array(await (await fetch(url(name))).arrayBuffer());
  const [ripcord, endowment, usdc] = await Promise.all([
    get('ripcord'),
    get('ripcord_endowment'),
    get('ripcord_test_usdc'),
  ]);
  return { ripcord, endowment, usdc };
}

const DOWN = { ok: false, error: 'NEAR is switched off in this simulation.' };

export class SimBackend {
  kind = 'sim';
  label = 'Simulator';
  hrp = 'tb';
  usesWallet = false;

  constructor(wasm) {
    this.wasm = wasm;
    this.reset();
  }

  static async create() {
    return new SimBackend(await loadContracts());
  }

  /** Starts over with a clean world and two lenders' offers on the book. */
  reset() {
    const w = createWorld({ wasm: this.wasm, params: PARAMS });
    this.w = w;
    this.role = A.borrower;
    this.killed = { website: false, relayer: false, oneclick: false, oracle: false, mpc: false, near: false };
    this.btcPrice = 76_000;
    this.history = [];

    // Two offers on the book, so a visitor has something to borrow against.
    w.near.call(A.lender, A.usdc, 'faucet', { amount: (10_000n * USDC).toString() });
    this.seedOffer(5_000n, 38_000n, 900, 30);
    this.seedOffer(5_000n, 30_000n, 650, 60);
  }

  seedOffer(dollars, pricePerBtc, aprBps, termBlocks) {
    const script = bytesToHex(addressToScript('tb', addressFor(0x1e)));
    this.tokenCall(
      A.lender,
      dollars * USDC,
      {
        offer: {
          micro_usdc_per_btc: (pricePerBtc * USDC).toString(),
          apr_bps: aprBps,
          term_blocks: termBlocks,
          btc_script: script,
        },
      },
    );
  }

  // ---- Identity ----

  account() {
    return this.role;
  }

  setRole(id) {
    this.role = id;
  }

  btcAddressOfRole() {
    return ROLES.find((r) => r.id === this.role)?.btc ?? ROLES[0].btc;
  }

  // ---- Reads ----

  async snapshot() {
    const { near, bitcoin, a } = this.w;
    const view = (c, m, args) => near.view(c, m, args);
    const account = this.role;
    return {
      tip: bitcoin.height,
      lightClientTip: bitcoin.height,
      config: view(a.ripcord, 'get_config'),
      stats: view(a.ripcord, 'get_stats'),
      endowment: view(a.endowment, 'get_stats'),
      vaults: view(a.ripcord, 'list_vaults'),
      offers: view(a.ripcord, 'list_offers'),
      account,
      usdcBalance: view(a.usdc, 'ft_balance_of', { account_id: account }),
      withdrawable: view(a.ripcord, 'get_balance', { account_id: account }),
      nearNow: near.timeMs,
      btcPrice: this.btcPrice,
      killed: { ...this.killed },
      saleRate: view(a.endowment, 'current_rate'),
      stakedOnPool: this.w.pool.state.staked.get(a.endowment)?.toString() ?? '0',
    };
  }

  auctionPrice(vaultId) {
    return this.w.near.view(A.ripcord, 'auction_price', { vault_id: String(vaultId) });
  }

  async btcBalanceOf(address) {
    return this.w.bitcoin.balanceOf(addressToScript('tb', address)).toString();
  }

  // ---- Contract actions ----

  send(contract, method, args = {}, deposit = 0n) {
    if (this.killed.near) return DOWN;
    const r = this.w.near.call(this.role, contract, method, args, { deposit });
    return { ok: r.ok && r.failures.length === 0, error: r.error ?? r.failures[0] ?? null, events: r.events };
  }

  tokenCall(sender, amount, msg) {
    if (this.killed.near) return DOWN;
    const before = BigInt(this.w.near.view(A.usdc, 'ft_balance_of', { account_id: sender }));
    const r = this.w.near.call(
      sender,
      A.usdc,
      'ft_transfer_call',
      { receiver_id: A.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) },
      { deposit: 1n },
    );
    const after = BigInt(this.w.near.view(A.usdc, 'ft_balance_of', { account_id: sender }));
    // The token refunds a refused action, so a transfer that changed nothing did nothing.
    const moved = before !== after;
    return { ok: moved, error: moved ? null : (r.failures[0] ?? 'refused'), events: r.events };
  }

  async openVault({ ownerPubkey, escapeHeight, expectedSats }) {
    const c = this.w.near.view(A.ripcord, 'get_config');
    return this.send(
      A.ripcord,
      'open_vault',
      { owner_pubkey: ownerPubkey, escape_height: escapeHeight, expected_sats: String(expectedSats) },
      BigInt(c.vault_fee) + BigInt(c.vault_storage),
    );
  }

  /** The simulated wallet pays the vault, and three blocks confirm it. */
  async sendDeposit(vault, sats) {
    const coin = this.w.bitcoin.fund(hexToBytes(vault.script_pubkey), sats);
    this.w.bitcoin.mine(3);
    this.coins = { ...this.coins, [vault.id]: coin };
    return coin;
  }

  async proveDeposit(vault) {
    const coin = this.coins?.[vault.id];
    if (!coin) return { ok: false, error: 'nothing has paid this vault yet' };
    const { raw_tx, proof } = this.w.bitcoin.proofFor(coin.txid);
    return this.send(A.ripcord, 'prove_deposit', { vault_id: vault.id, raw_tx, vout: coin.vout, proof });
  }

  borrow({ vaultId, offerId, principal, payoutTo }) {
    return this.send(
      A.ripcord,
      'borrow',
      { vault_id: vaultId, offer_id: offerId, principal: principal.toString(), payout_to: payoutTo ?? null },
      1n,
    );
  }

  repay(vault) {
    return this.tokenCall(this.role, BigInt(vault.loan.debt), { repay: { vault_id: vault.id } });
  }

  release(vaultId, destination) {
    return this.send(A.ripcord, 'release', { vault_id: vaultId, destination }, 1n);
  }

  requestSignature(vaultId, feeSats) {
    return this.send(A.ripcord, 'request_signature', { vault_id: vaultId, fee_sats: String(feeSats) });
  }

  startAuction(vaultId) {
    return this.send(A.ripcord, 'start_auction', { vault_id: vaultId });
  }

  bid(vaultId, amount, btcScript) {
    return this.tokenCall(this.role, amount, { bid: { vault_id: vaultId, btc_script: btcScript } });
  }

  claim(vaultId) {
    return this.send(A.ripcord, 'claim_collateral', { vault_id: vaultId });
  }

  makeOffer({ amount, microUsdcPerBtc, aprBps, termBlocks, btcScript }) {
    return this.tokenCall(this.role, amount, {
      offer: {
        micro_usdc_per_btc: microUsdcPerBtc.toString(),
        apr_bps: aprBps,
        term_blocks: termBlocks,
        btc_script: btcScript,
      },
    });
  }

  cancelOffer(offerId) {
    return this.send(A.ripcord, 'cancel_offer', { offer_id: offerId }, 1n);
  }

  withdraw() {
    return this.send(A.ripcord, 'withdraw', {}, 1n);
  }

  // ---- Bitcoin ----

  /** Puts a raw transaction on Bitcoin. Refusals carry the real reason. */
  async broadcast(rawHex) {
    try {
      const txid = this.w.bitcoin.submit(rawHex);
      this.w.bitcoin.mine(1);
      return { ok: true, txid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  explorerTx() {
    return null;
  }

  // ---- The control tower ----

  mine(count) {
    this.w.bitcoin.mine(count);
  }

  advance(seconds) {
    this.w.near.advance(seconds);
  }

  setKilled(name, value) {
    this.killed[name] = value;
    if (name === 'mpc' || name === 'near') this.w.mpc.state.offline = this.killed.mpc || this.killed.near;
    if (name === 'near') this.w.client.state.paused = value;
  }

  setPrice(usd) {
    this.btcPrice = usd;
  }

  /** The endowment's permissionless upkeep, run as whoever is signed in. */
  stakeEndowment() {
    return this.send(A.endowment, 'stake');
  }

  scriptOf(address) {
    return bytesToHex(addressToScript('tb', address));
  }

  addressOf(scriptHex) {
    const bytes = hexToBytes(scriptHex);
    return encodeSegwit('tb', bytes[0] === 0 ? 0 : 1, bytes.slice(2));
  }

  vaultAddressOf(script) {
    return encodeSegwit('tb', 0, p2wshScriptPubkey(script).slice(2));
  }
}
