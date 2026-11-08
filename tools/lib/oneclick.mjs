// NEAR Intents through the 1Click API, following NEAR's `near-intents` agent skill:
//
//   GET /v0/tokens → POST /v0/quote (dry) → POST /v0/quote (wet) → deposit
//     → POST /v0/deposit/submit → GET /v0/status, until a terminal status
//
// Dry quotes move nothing. A wet quote returns a deposit address, and only a deposit to that
// address moves money. Works in Node and browsers, and depends on nothing else here.

export const API = 'https://1click.chaindefuser.com/v0';

/** USDC on NEAR, the token Ripcord lends. */
export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

// Example addresses for price quotes only. 1Click refuses burn addresses, and a dry quote
// moves nothing, so these never receive anything.
const SAMPLE_EVM = '0xb4c2fbec9d610F9A3a9b843c47b1A8095ceC887C';
const SAMPLE_SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/**
 * Where borrowed dollars can land, and where repayments can come from. The skill says to
 * take asset ids from GET /v0/tokens, so `resolveRoutes` replaces these with the live ones.
 * They are kept here so a price still shows if the token list cannot be read.
 */
export const USDC_ROUTES = [
  { id: 'base', label: 'Base', blockchain: 'base', kind: 'evm', asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', sample: SAMPLE_EVM },
  { id: 'arb', label: 'Arbitrum', blockchain: 'arb', kind: 'evm', asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', sample: SAMPLE_EVM },
  { id: 'sol', label: 'Solana', blockchain: 'sol', kind: 'sol', asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', sample: SAMPLE_SOL },
  { id: 'eth', label: 'Ethereum', blockchain: 'eth', kind: 'evm', asset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', sample: SAMPLE_EVM },
];

/** Statuses after which nothing more happens to a transfer. */
export const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT']);

async function request(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? `1Click answered ${res.status}`);
  return json;
}

/** Every token 1Click supports. */
export const tokens = (options) => request('/tokens', options);

/** Replaces each route's asset id with the one 1Click lists now. */
export function resolveRoutes(list, routes = USDC_ROUTES) {
  return routes.map((route) => {
    const token = list.find((t) => t.blockchain === route.blockchain && t.symbol === 'USDC');
    return token ? { ...route, asset: token.assetId, decimals: token.decimals, listed: true } : { ...route, listed: false };
  });
}

/** Checks an address has the right shape for a route's chain, before asking for a quote. */
export function looksLikeAddress(route, text) {
  const value = String(text ?? '').trim();
  if (route.kind === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(value);
  if (route.kind === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value) && value.length >= 2 && value.length <= 64;
}

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

export function quote(body, options) {
  return request('/quote', {
    ...options,
    method: 'POST',
    body: {
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      slippageTolerance: 50,
      deadline: minutesFromNow(60),
      referral: 'ripcord',
      ...body,
    },
  });
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
export function repayQuote(route, microUsdc, recipient, refundTo = route.sample, options) {
  return quote(
    {
      dry: true,
      swapType: 'EXACT_OUTPUT',
      originAsset: route.asset,
      destinationAsset: USDC_NEAR,
      amount: String(microUsdc),
      recipient,
      refundTo,
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

/**
 * A committed quote for sending borrowed dollars to another chain. The deposit address it
 * returns is a NEAR account, and the loan is paid straight into it. If the swap cannot be
 * done, 1Click refunds `refundTo` on NEAR.
 */
export function deliveryQuote({ route, microUsdc, recipient, refundTo, minutes = 20 }, options) {
  return quote(
    {
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: USDC_NEAR,
      destinationAsset: route.asset,
      amount: String(microUsdc),
      recipient,
      refundTo,
      deadline: minutesFromNow(minutes),
    },
    options,
  );
}

/**
 * A committed quote for bringing exactly `microUsdc` to a NEAR account from another chain.
 * The user sends from their own wallet on that chain to the deposit address. A refund goes
 * back to `refundTo` on that chain.
 */
export function inboundQuote({ route, microUsdc, recipient, refundTo, minutes = 30 }, options) {
  return quote(
    {
      dry: false,
      swapType: 'EXACT_OUTPUT',
      originAsset: route.asset,
      destinationAsset: USDC_NEAR,
      amount: String(microUsdc),
      recipient,
      refundTo,
      deadline: minutesFromNow(minutes),
    },
    options,
  );
}

/** Tells 1Click about a deposit, which speeds it up. Optional. */
export function submitDeposit({ txHash, depositAddress, nearSenderAccount }, options) {
  return request('/deposit/submit', { ...options, method: 'POST', body: { txHash, depositAddress, nearSenderAccount } });
}

/** Where a transfer stands. */
export function status(depositAddress, options) {
  return request(`/status?depositAddress=${encodeURIComponent(depositAddress)}`, options);
}

const formatUnits = (amount, decimals = 6) => {
  if (amount === undefined || amount === null || amount === '') return null;
  const n = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const cents = (n * 100n) / scale;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};

const short = (text) => (text && text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text);

/**
 * Plain words for a transfer's status, and where the money is at that moment. Pure, so the
 * app and the tests share it. `direction` is 'out' for dollars leaving NEAR, 'in' for dollars
 * coming to NEAR. `chain` is the other chain's name.
 */
export function describeTransfer(statusResponse, { direction, chain, recipient, refundTo }) {
  const code = statusResponse?.status ?? 'PENDING_DEPOSIT';
  const details = statusResponse?.swapDetails ?? {};
  const links = [
    ...(details.originChainTxHashes ?? []).map((t) => ({ label: `Deposit ${short(t.hash)}`, url: t.explorerUrl || null })),
    ...(details.destinationChainTxHashes ?? []).map((t) => ({ label: `Delivery ${short(t.hash)}`, url: t.explorerUrl || null })),
  ];
  const out = direction === 'out';
  const from = out ? 'NEAR' : chain;
  const to = out ? chain : 'NEAR';
  const delivered = formatUnits(details.amountOut);
  const refunded = formatUnits(details.refundedAmount);
  const words = {
    PENDING_DEPOSIT: {
      tone: 'wait',
      title: out ? 'Waiting for the dollars to reach NEAR Intents' : `Waiting for your deposit on ${chain}`,
      where: out ? 'Leaving the Ripcord contract for the NEAR Intents deposit address' : `Still in your wallet on ${chain}`,
    },
    KNOWN_DEPOSIT_TX: {
      tone: 'move',
      title: 'NEAR Intents has seen the deposit',
      where: `At the NEAR Intents deposit address on ${from}`,
    },
    PROCESSING: {
      tone: 'move',
      title: `Moving to ${to}`,
      where: `With NEAR Intents, being exchanged for USDC on ${to}`,
    },
    SUCCESS: {
      tone: 'good',
      title: `Delivered on ${to}`,
      where: `In ${short(recipient)} on ${to}${delivered ? `: ${delivered} USDC` : ''}`,
    },
    REFUNDED: {
      tone: 'bad',
      title: 'Refunded',
      where: `Back in ${short(refundTo)} on ${from}${refunded ? `: ${refunded} USDC` : ''}${details.refundReason ? `. Reason: ${details.refundReason}` : ''}`,
    },
    FAILED: {
      tone: 'bad',
      title: 'The transfer failed',
      where: `Held by NEAR Intents at the deposit address. Keep the address below: it identifies this transfer if you need help`,
    },
    INCOMPLETE_DEPOSIT: {
      tone: 'bad',
      title: 'The deposit was less than the quote',
      where: `At the deposit address. NEAR Intents returns it to ${short(refundTo)} on ${from}`,
    },
  }[code] ?? { tone: 'wait', title: code, where: 'Unknown' };
  return { code, terminal: TERMINAL.has(code), ...words, links };
}
