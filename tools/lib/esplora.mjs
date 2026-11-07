// Reads Bitcoin through a public Esplora API. Nothing here is trusted by the contract: the
// light client checks every proof, and anyone can swap in a different server.

import { merkleProof } from './btc-core.mjs';

export const ESPLORA = {
  testnet3: 'https://mempool.space/testnet/api',
  mainnet: 'https://mempool.space/api',
};

export const EXPLORER = {
  testnet3: 'https://mempool.space/testnet',
  mainnet: 'https://mempool.space',
};

async function text(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`);
  return (await res.text()).trim();
}

const json = async (url) => JSON.parse(await text(url));

export function esplora(network) {
  const base = ESPLORA[network];
  return {
    tip: async () => Number(await text(`${base}/blocks/tip/height`)),
    tx: (id) => json(`${base}/tx/${id}`),
    txHex: (id) => text(`${base}/tx/${id}/hex`),
    blockTxids: (hash) => json(`${base}/block/${hash}/txids`),
    utxos: (address) => json(`${base}/address/${address}/utxo`),
    addressTxs: (address) => json(`${base}/address/${address}/txs`),
    broadcast: (hex) => text(`${base}/tx`, { method: 'POST', body: hex }),
    fees: () => json(`${base}/v1/fees/recommended`),
  };
}

/** Builds the proof `prove_deposit` takes for a confirmed transaction. */
export async function buildProof(api, txid) {
  const tx = await api.tx(txid);
  if (!tx.status?.confirmed) throw new Error('the transaction is not confirmed yet');
  const [raw, txids] = await Promise.all([api.txHex(txid), api.blockTxids(tx.status.block_hash)]);
  const index = txids.indexOf(txid);
  if (index < 0) throw new Error('the transaction is not in the block it claims');
  return {
    raw_tx: raw,
    proof: {
      block_hash: tx.status.block_hash,
      tx_index: String(index),
      merkle_proof: merkleProof(txids, index).proof,
      coinbase_txid: txids[0],
      coinbase_merkle_proof: merkleProof(txids, 0).proof,
    },
    confirmedAt: tx.status.block_height,
  };
}
