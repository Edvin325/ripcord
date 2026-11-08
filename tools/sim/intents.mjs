// A stand-in for NEAR Intents' 1Click service in the simulator. Intents has no testnet, so
// the simulator plays its part: it hands out deposit addresses, watches them on the simulated
// chain, and moves through the same statuses as the real API. It can be told to deliver, to
// refund or to fail, so the app's handling of each one can be seen and tested.
//
// It is never presented as the real thing: every hash it makes up starts with "sim-".

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '../lib/btc-core.mjs';
import { TERMINAL, USDC_NEAR } from '../lib/oneclick.mjs';

const NEAR = 10n ** 24n;
// About what real quotes for USDC between chains cost when measured: $100 in, $99.98 out.
const FEE_BPS = 2n;

export function simIntents(world, { treasury = 'intents.test' } = {}) {
  const { near, a } = world;
  const orders = new Map();
  const state = { outcome: 'deliver', made: 0 };

  near.addAccount(treasury, 100n * NEAR);
  near.call(treasury, a.usdc, 'storage_deposit', {}, { deposit: NEAR / 100n });
  for (let i = 0; i < 5; i++) near.call(treasury, a.usdc, 'faucet', { amount: (10_000n * 1_000_000n).toString() });

  const balance = (account) => BigInt(near.view(a.usdc, 'ft_balance_of', { account_id: account }) ?? '0');
  const fake = (label) => `sim-${bytesToHex(sha256(`${label} ${state.made} ${near.timeMs}`)).slice(0, 40)}`;
  const format = (micro) => `${micro / 1_000_000n}.${String((micro % 1_000_000n) / 10_000n).padStart(2, '0')}`;

  /** The same shape as POST /v0/quote. */
  function quote(body) {
    const amount = BigInt(body.amount);
    const fee = (amount * FEE_BPS) / 10_000n;
    const out = body.originAsset === USDC_NEAR;
    const amountIn = body.swapType === 'EXACT_OUTPUT' ? amount + fee : amount;
    const amountOut = body.swapType === 'EXACT_OUTPUT' ? amount : amount - fee;
    const response = {
      correlationId: fake('quote'),
      quoteRequest: body,
      quote: {
        amountIn: amountIn.toString(),
        amountInFormatted: format(amountIn),
        amountOut: amountOut.toString(),
        amountOutFormatted: format(amountOut),
        timeEstimate: 20,
        deadline: new Date(near.timeMs + 20 * 60_000).toISOString(),
      },
    };
    if (body.dry) return response;

    state.made += 1;
    // A NEAR deposit address is an implicit account, as on the real service. Dollars coming
    // in from another chain get a made-up address on that chain instead.
    const depositAddress = out ? bytesToHex(sha256(`sim deposit ${state.made}`)) : `0x${bytesToHex(sha256(`sim evm ${state.made}`)).slice(0, 40)}`;
    if (out) near.addAccount(depositAddress, NEAR);
    response.quote.depositAddress = depositAddress;
    orders.set(depositAddress, {
      body,
      out,
      status: 'PENDING_DEPOSIT',
      amountIn,
      amountOut,
      outcome: state.outcome,
      deposited: false,
      details: {},
      updatedAt: near.timeMs,
    });
    return response;
  }

  /** What a user's own wallet on another chain does: pays a deposit address. */
  function payFromOtherChain(depositAddress) {
    const order = orders.get(depositAddress);
    if (!order || order.out) throw new Error('not a deposit address for dollars coming in');
    order.deposited = true;
    order.details.originChainTxHashes = [{ hash: fake('origin'), explorerUrl: '' }];
  }

  function refund(order, address, reason) {
    if (order.out) {
      near.call(address, a.usdc, 'ft_transfer', { receiver_id: order.body.refundTo, amount: order.amountIn.toString() }, { deposit: 1n });
    }
    order.status = 'REFUNDED';
    order.details.refundedAmount = order.amountIn.toString();
    order.details.refundReason = reason;
  }

  /** One step forward, the way time passes on the real service. */
  function step(address, order) {
    if (TERMINAL.has(order.status)) return;
    if (order.status === 'PENDING_DEPOSIT') {
      const arrived = order.out ? balance(address) >= order.amountIn : order.deposited;
      if (!arrived) return;
      if (order.out) {
        order.details.originChainTxHashes = [{ hash: fake('origin'), explorerUrl: '' }];
      }
      order.status = 'KNOWN_DEPOSIT_TX';
      return;
    }
    if (order.status === 'KNOWN_DEPOSIT_TX') {
      order.status = 'PROCESSING';
      return;
    }
    if (order.outcome === 'refund') {
      refund(order, address, 'Simulated: no market maker filled the order before the deadline');
      return;
    }
    if (order.outcome === 'fail') {
      order.status = 'FAILED';
      return;
    }
    if (order.out) {
      // The dollars leave NEAR for the other chain.
      near.call(address, a.usdc, 'ft_transfer', { receiver_id: treasury, amount: order.amountIn.toString() }, { deposit: 1n });
    } else {
      near.call(treasury, a.usdc, 'ft_transfer', { receiver_id: order.body.recipient, amount: order.amountOut.toString() }, { deposit: 1n });
    }
    order.details.amountOut = order.amountOut.toString();
    order.details.amountOutFormatted = format(order.amountOut);
    order.details.destinationChainTxHashes = [{ hash: fake('destination'), explorerUrl: '' }];
    order.status = 'SUCCESS';
  }

  /** The same shape as GET /v0/status. Each call moves a transfer one step on. */
  function status(depositAddress) {
    const order = orders.get(depositAddress);
    if (!order) throw new Error('Deposit address not found');
    step(depositAddress, order);
    order.updatedAt = near.timeMs;
    return {
      correlationId: fake('status'),
      status: order.status,
      updatedAt: new Date(near.timeMs).toISOString(),
      swapDetails: {
        amountIn: order.amountIn.toString(),
        ...order.details,
      },
    };
  }

  return { state, orders, quote, status, payFromOtherChain, treasury };
}

/**
 * A `fetch` that answers 1Click's routes from the simulated service, so the very code that
 * talks to the real API runs unchanged in the simulator and in the tests.
 */
export function simFetch(sim) {
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  return async (url, init = {}) => {
    const u = new URL(url);
    try {
      if (u.pathname.endsWith('/quote')) return reply(200, sim.quote(JSON.parse(init.body)));
      if (u.pathname.endsWith('/status')) return reply(200, sim.status(u.searchParams.get('depositAddress')));
      if (u.pathname.endsWith('/deposit/submit')) return reply(200, { ok: true });
      return reply(404, { message: `the simulated 1Click has no ${u.pathname}` });
    } catch (e) {
      return reply(400, { message: e.message });
    }
  };
}
