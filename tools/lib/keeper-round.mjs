// One round of the keeper, written against an `env` of services so the tests can run it on
// the simulator. It holds no special rights: everything here is an ordinary call any
// account can make, which is why stopping it costs nobody their funds.

const DOLLAR = 1_000_000n; // the smallest sale the endowment will open
const NEAR = 10n ** 24n;

async function tryProve(env, v, config) {
  const { d, keeper, api, buildProof, call, say } = env;
  const coin = (await api.utxos(v.address)).find((u) => BigInt(u.value) >= BigInt(v.expected_sats));
  if (!coin?.status?.confirmed) return;
  const tip = await api.tip();
  if (tip - coin.status.block_height + 1 < config.confirmations) return;
  const { raw_tx, proof } = await buildProof(api, coin.txid);
  const r = await call(d.network, keeper, d.ripcord, 'prove_deposit', { vault_id: v.id, raw_tx, vout: coin.vout, proof });
  say(`vault ${v.id}: proved deposit ${r.ok ? 'ok' : 'refused'}`);
}

async function tryBroadcast(env, v) {
  const seen = await env.api.tx(v.signed_txid).then(
    () => true,
    () => false,
  );
  if (seen) return;
  const id = await env.api.broadcast(v.signed_tx).catch((e) => `refused: ${e.message}`);
  env.say(`vault ${v.id}: broadcast ${id}`);
}

async function tendVault(env, v, config, tip) {
  const { d, keeper, call, view, say } = env;
  if (v.status === 'awaiting_deposit') {
    await tryProve(env, v, config);
  } else if (v.status === 'borrowed' && tip > v.loan.grace_end_height) {
    const r = await call(d.network, keeper, d.ripcord, 'start_auction', { vault_id: v.id });
    say(`vault ${v.id}: started auction ${r.ok ? 'ok' : 'refused'}`);
  } else if (v.status === 'auction') {
    const price = await view(d.network, d.ripcord, 'auction_price', { vault_id: v.id });
    if (price === null) {
      const r = await call(d.network, keeper, d.ripcord, 'claim_collateral', { vault_id: v.id });
      say(`vault ${v.id}: no bids, coins go to the lender ${r.ok ? 'ok' : 'refused'}`);
    }
  } else if (v.status === 'settling' && v.signed_tx) {
    await tryBroadcast(env, v);
  }
}

/** The endowment's upkeep. These calls earn no bounty, and each one is open to anyone. */
async function upkeep(env) {
  const { d, keeper, call, view, say } = env;
  const step = async (label, method) => {
    const r = await call(d.network, keeper, d.endowment, method);
    say(`endowment: ${label} ${r.ok ? 'ok' : 'refused'}`);
  };

  const owed = await view(d.network, d.ripcord, 'get_balance', { account_id: d.endowment });
  if (BigInt(owed) >= DOLLAR) await step('collected interest', 'collect_usdc');

  const [held, rate] = await Promise.all([
    view(d.network, d.usdc, 'ft_balance_of', { account_id: d.endowment }),
    view(d.network, d.endowment, 'current_rate'),
  ]);
  if (BigInt(held) >= DOLLAR && rate === null) await step('opened a sale', 'start_sale');

  const e = await view(d.network, d.endowment, 'get_stats');
  if (BigInt(e.liquid_balance) > BigInt(e.keeper_float) + 5n * NEAR) await step('staked', 'stake');
}

export async function keeperRound(env) {
  const { d, view, listAll, say } = env;
  const [vaults, config, tip] = await Promise.all([
    listAll(d.network, d.ripcord, 'list_vaults'),
    view(d.network, d.ripcord, 'get_config'),
    view(d.network, d.btcClient, 'get_last_block_height'),
  ]);
  for (const v of vaults) {
    try {
      await tendVault(env, v, config, tip);
    } catch (e) {
      say(`vault ${v.id}: ${e.message.slice(0, 160)}`);
    }
  }
  await upkeep(env).catch((e) => say(`endowment: ${e.message.slice(0, 160)}`));
}
