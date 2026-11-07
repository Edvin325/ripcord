// The live backend: NEAR testnet or mainnet, Bitcoin through a public API, and a real
// wallet. It exposes the same methods as the simulator, so every page works on both.

import { NearConnector } from '@hot-labs/near-connect';
import { addressToScript, bytesToHex, encodeSegwit, hexToBytes, merkleProof, p2wshScriptPubkey } from '@tools/lib/btc-core.mjs';

const RPC = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
};

const BTC = {
  testnet3: { api: 'https://mempool.space/testnet/api', site: 'https://mempool.space/testnet' },
  mainnet: { api: 'https://mempool.space/api', site: 'https://mempool.space' },
};

const TGAS = 10n ** 12n;
const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

async function btcFetch(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new Error((await res.text()).slice(0, 200));
  return (await res.text()).trim();
}

export class LiveBackend {
  kind = 'live';
  usesWallet = true;

  constructor(deployment) {
    this.d = deployment;
    this.label = deployment.network === 'mainnet' ? 'Mainnet' : 'Testnet';
    this.hrp = deployment.network === 'mainnet' ? 'bc' : 'tb';
    this.btc = BTC[deployment.btcNetwork];
    this.connected = null;
    this.connector = new NearConnector({ network: deployment.network });
    this.connector.on('wallet:signIn', (t) => {
      this.connected = t.accounts[0].accountId;
      this.onAccountChange?.();
    });
    this.connector.on('wallet:signOut', () => {
      this.connected = null;
      this.onAccountChange?.();
    });
  }

  account() {
    return this.connected;
  }

  connect() {
    return this.connector.connect();
  }

  disconnect() {
    return this.connector.disconnect();
  }

  btcAddressOfRole() {
    return '';
  }

  // ---- Reads ----

  async rpc(method, params) {
    let last;
    for (const url of RPC[this.d.network]) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'ripcord', method, params }),
        });
        const body = await res.json();
        if (body.error) throw new Error(JSON.stringify(body.error));
        return body.result;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  async view(contract, method, args = {}) {
    const r = await this.rpc('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contract,
      method_name: method,
      args_base64: toBase64(JSON.stringify(args)),
    });
    if (r.error) throw new Error(r.error);
    const text = new TextDecoder().decode(new Uint8Array(r.result));
    return text ? JSON.parse(text) : null;
  }

  async snapshot() {
    const d = this.d;
    const account = this.connected;
    const [lightClientTip, tip, config, stats, endowment, vaults, offers, usdcBalance, withdrawable, saleRate] =
      await Promise.all([
        this.view(d.btcClient, 'get_last_block_height'),
        btcFetch(this.btc.api, '/blocks/tip/height').then(Number),
        this.view(d.ripcord, 'get_config'),
        this.view(d.ripcord, 'get_stats'),
        this.view(d.endowment, 'get_stats'),
        this.view(d.ripcord, 'list_vaults'),
        this.view(d.ripcord, 'list_offers'),
        account ? this.view(d.usdc, 'ft_balance_of', { account_id: account }) : '0',
        account ? this.view(d.ripcord, 'get_balance', { account_id: account }) : '0',
        this.view(d.endowment, 'current_rate'),
      ]);
    return {
      tip,
      lightClientTip,
      config,
      stats,
      endowment,
      vaults,
      offers,
      account,
      usdcBalance,
      withdrawable,
      nearNow: Date.now(),
      btcPrice: await this.referencePrice(),
      killed: null,
      saleRate,
      stakedOnPool: endowment.principal_staked,
    };
  }

  /** For display only. The contract never sees a price. */
  async referencePrice() {
    if (this.price && Date.now() - this.price.at < 60_000) return this.price.usd;
    try {
      const tokens = await (await fetch('https://1click.chaindefuser.com/v0/tokens')).json();
      const btc = tokens.find((t) => t.symbol === 'BTC' && t.blockchain === 'btc');
      this.price = { usd: btc.price, at: Date.now() };
      return btc.price;
    } catch {
      return this.price?.usd ?? null;
    }
  }

  auctionPrice(vaultId) {
    return this.view(this.d.ripcord, 'auction_price', { vault_id: String(vaultId) });
  }

  async btcBalanceOf(address) {
    const a = JSON.parse(await btcFetch(this.btc.api, `/address/${address}`));
    return String(a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum);
  }

  /** The first coin paying this vault, with its confirmation count. */
  async findDeposit(vault) {
    const utxos = JSON.parse(await btcFetch(this.btc.api, `/address/${vault.address}/utxo`));
    const coin = utxos[0];
    if (!coin) return null;
    const tip = Number(await btcFetch(this.btc.api, '/blocks/tip/height'));
    const confirmations = coin.status.confirmed ? tip - coin.status.block_height + 1 : 0;
    return { ...coin, confirmations };
  }

  // ---- Signing ----

  async send(contractId, methodName, args = {}, deposit = 0n, tgas = 300n) {
    if (!this.connected) return { ok: false, error: 'Connect a wallet first.' };
    try {
      const wallet = await this.connector.wallet();
      const outcome = await wallet.signAndSendTransaction({
        receiverId: contractId,
        actions: [
          {
            type: 'FunctionCall',
            params: { methodName, args, gas: (tgas * TGAS).toString(), deposit: deposit.toString() },
          },
        ],
      });
      return this.readOutcome(outcome);
    } catch (e) {
      return { ok: false, error: e.message ?? String(e) };
    }
  }

  readOutcome(outcome) {
    const all = [outcome?.transaction_outcome, ...(outcome?.receipts_outcome ?? [])].filter(Boolean);
    const logs = all.flatMap((r) => r.outcome.logs ?? []);
    const failures = all.map((r) => r.outcome.status?.Failure).filter(Boolean);
    return {
      ok: failures.length === 0,
      error: failures[0] ? JSON.stringify(failures[0]) : null,
      events: logs
        .filter((l) => l.startsWith('EVENT_JSON:'))
        .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length))),
      hash: outcome?.transaction?.hash,
    };
  }

  tokenCall(amount, msg) {
    return this.send(
      this.d.usdc,
      'ft_transfer_call',
      { receiver_id: this.d.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) },
      1n,
    );
  }

  // ---- Contract actions ----

  async openVault({ ownerPubkey, escapeHeight, expectedSats }) {
    const c = await this.view(this.d.ripcord, 'get_config');
    return this.send(
      this.d.ripcord,
      'open_vault',
      { owner_pubkey: ownerPubkey, escape_height: escapeHeight, expected_sats: String(expectedSats) },
      BigInt(c.vault_fee) + BigInt(c.vault_storage),
    );
  }

  async proveDeposit(vault) {
    const coin = await this.findDeposit(vault);
    if (!coin?.status?.confirmed) return { ok: false, error: 'No confirmed deposit yet.' };
    const hash = coin.status.block_hash;
    const [raw, txidsText] = await Promise.all([
      btcFetch(this.btc.api, `/tx/${coin.txid}/hex`),
      btcFetch(this.btc.api, `/block/${hash}/txids`),
    ]);
    const txids = JSON.parse(txidsText);
    const index = txids.indexOf(coin.txid);
    return this.send(this.d.ripcord, 'prove_deposit', {
      vault_id: vault.id,
      raw_tx: raw,
      vout: coin.vout,
      proof: {
        block_hash: hash,
        tx_index: String(index),
        merkle_proof: merkleProof(txids, index).proof,
        coinbase_txid: txids[0],
        coinbase_merkle_proof: merkleProof(txids, 0).proof,
      },
    });
  }

  borrow({ vaultId, offerId, principal, payoutTo }) {
    return this.send(
      this.d.ripcord,
      'borrow',
      { vault_id: vaultId, offer_id: offerId, principal: principal.toString(), payout_to: payoutTo ?? null },
      1n,
    );
  }

  repay(vault) {
    return this.tokenCall(BigInt(vault.loan.debt), { repay: { vault_id: vault.id } });
  }

  release(vaultId, destination) {
    return this.send(this.d.ripcord, 'release', { vault_id: vaultId, destination }, 1n);
  }

  requestSignature(vaultId, feeSats) {
    return this.send(this.d.ripcord, 'request_signature', { vault_id: vaultId, fee_sats: String(feeSats) });
  }

  startAuction(vaultId) {
    return this.send(this.d.ripcord, 'start_auction', { vault_id: vaultId });
  }

  bid(vaultId, amount, btcScript) {
    return this.tokenCall(amount, { bid: { vault_id: vaultId, btc_script: btcScript } });
  }

  claim(vaultId) {
    return this.send(this.d.ripcord, 'claim_collateral', { vault_id: vaultId });
  }

  makeOffer({ amount, microUsdcPerBtc, aprBps, termBlocks, btcScript }) {
    return this.tokenCall(amount, {
      offer: {
        micro_usdc_per_btc: microUsdcPerBtc.toString(),
        apr_bps: aprBps,
        term_blocks: termBlocks,
        btc_script: btcScript,
      },
    });
  }

  cancelOffer(offerId) {
    return this.send(this.d.ripcord, 'cancel_offer', { offer_id: offerId }, 1n);
  }

  withdraw() {
    return this.send(this.d.ripcord, 'withdraw', {}, 1n);
  }

  stakeEndowment() {
    return this.send(this.d.endowment, 'stake');
  }

  // ---- Bitcoin ----

  async broadcast(rawHex) {
    try {
      const txid = await btcFetch(this.btc.api, '/tx', { method: 'POST', body: rawHex });
      return { ok: true, txid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  explorerTx(txid) {
    return `${this.btc.site}/tx/${txid}`;
  }

  scriptOf(address) {
    return bytesToHex(addressToScript(this.hrp, address));
  }

  addressOf(scriptHex) {
    const bytes = hexToBytes(scriptHex);
    return encodeSegwit(this.hrp, bytes[0] === 0 ? 0 : 1, bytes.slice(2));
  }

  vaultAddressOf(script) {
    return encodeSegwit(this.hrp, 0, p2wshScriptPubkey(script).slice(2));
  }
}
