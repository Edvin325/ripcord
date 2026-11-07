// NEAR Intents through the 1Click API. Quotes here are `dry`: real prices from real solvers,
// with no deposit address and no funds moved. Intents has no testnet, so this is how a
// testnet build shows real cross-chain pricing.
//
// Works in Node and browsers, and depends on nothing else in this repository.

const API = 'https://1click.chaindefuser.com/v0';

export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

// Example addresses for price quotes only. 1Click refuses burn addresses, and a dry quote
// moves nothing, so these never receive anything.
const SAMPLE_EVM = '0xb4c2fbec9d610F9A3a9b843c47b1A8095ceC887C';
const SAMPLE_SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** Where borrowed dollars can land, and where repayments can come from. */
export const USDC_ROUTES = [
  { id: 'base', label: 'Base', asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', sample: SAMPLE_EVM },
  { id: 'arb', label: 'Arbitrum', asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', sample: SAMPLE_EVM },
  { id: 'sol', label: 'Solana', asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', sample: SAMPLE_SOL },
  { id: 'eth', label: 'Ethereum', asset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', sample: SAMPLE_EVM },
];

export async function quote(request, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      slippageTolerance: 50,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      ...request,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `1Click answered ${res.status}`);
  return body;
}

/** Live price of delivering `microUsdc` from NEAR to `route`. Moves nothing. */
export function payoutQuote(route, microUsdc, recipient, refundTo, options) {
  return quote(
    {
      dry: true,
      swapType: 'EXACT_INPUT',
      originAsset: USDC_NEAR,
      destinationAsset: route.asset,
      amount: String(microUsdc),
      recipient: recipient ?? route.sample,
      refundTo,
    },
    options,
  );
}

/** Live cost of repaying exactly `microUsdc` on NEAR with USDC from `route`. Moves nothing. */
export function repayQuote(route, microUsdc, ripcord, vaultId, options) {
  return quote(
    {
      dry: true,
      swapType: 'EXACT_OUTPUT',
      originAsset: route.asset,
      destinationAsset: USDC_NEAR,
      amount: String(microUsdc),
      recipient: ripcord,
      refundTo: route.sample,
      customRecipientMsg: JSON.stringify({ repay: { vault_id: String(vaultId) } }),
    },
    options,
  );
}

/** What selling native Bitcoin through Intents pays right now. */
export function btcSaleQuote(sats, recipient, refundTo, options) {
  return quote(
    {
      dry: true,
      swapType: 'EXACT_INPUT',
      originAsset: 'nep141:btc.omft.near',
      destinationAsset: USDC_NEAR,
      amount: String(sats),
      recipient,
      refundTo,
      slippageTolerance: 100,
    },
    options,
  );
}
