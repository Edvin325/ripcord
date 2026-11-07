// The settings of the testnet deployment: short loans on a chain whose blocks are irregular,
// so a full run fits in a couple of hours. The simulator rehearsal uses these same numbers.

const NEAR = 10n ** 24n;
const USDC = 1_000_000n;

export const PARAMS = {
  min_collateral_sats: 5_000,
  grace_blocks: 2,
  start_window_blocks: 3,
  auction_seconds: 900,
  auction_blocks: 4,
  safety_blocks: 35,
  auction_start_bps: 30_000,
  flywheel_share_bps: 1_000,
  max_btc_fee_bps: 1_000,
  max_tip_age_seconds: 3_000,
};

export const CONFIRMATIONS = 2;

export const VAULT_FEE = NEAR / 10n;

export const KEEPER_BOUNTY = NEAR / 100n;

export const KEEPER_FLOAT = NEAR / 2n;

// 16 NEAR per dollar, halving twelve times, in half an hour so a test run can reach a
// sensible rate. A long-lived deployment would run this over a day.
export const SALE = {
  sale_seconds: '1800',
  sale_start_rate: ((16n * NEAR) / USDC).toString(),
  sale_halvings: 12,
};
