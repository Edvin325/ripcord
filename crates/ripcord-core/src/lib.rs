//! Ripcord's rules as pure functions.
//!
//! Nothing here touches a chain, a clock or storage: heights and times come in as
//! arguments. That keeps every rule testable on its own, and it means the contract is
//! only wiring around this file.
//!
//! There is deliberately no price feed anywhere. A lender states how many dollars they
//! will lend per bitcoin. If the loan is not repaid, a Dutch auction finds the market
//! price. Nothing can force a sale before the due date, so a borrower cannot be
//! liquidated by a dip, and there is no oracle to manipulate or to go stale.

use core::fmt;

/// 144 blocks a day. Interest is priced in blocks because Bitcoin is the loan's clock.
pub const BLOCKS_PER_YEAR: u128 = 52_560;

pub const SATS_PER_BTC: u128 = 100_000_000;

pub const BPS: u128 = 10_000;

/// Refuses absurd offers, not expensive ones: 1000% APR.
pub const MAX_APR_BPS: u32 = 100_000;

/// USDC has 6 decimals. Ten million dollars per bitcoin, in micro-USDC. Far above any
/// sensible offer, and low enough that the arithmetic below cannot overflow.
pub const MAX_MICRO_USDC_PER_BTC: u128 = 10_000_000 * 1_000_000;

/// Set once when the contract is deployed. There is no way to change them afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    /// Smallest deposit accepted, so a vault can always pay a Bitcoin fee.
    pub min_collateral_sats: u64,
    /// Blocks after the due height before the auction may start.
    pub grace_blocks: u32,
    /// How long the auction runs on the NEAR clock.
    pub auction_seconds: u64,
    /// Upper bound on the Bitcoin blocks that pass during the auction.
    pub auction_blocks: u32,
    /// Blocks that must remain between the end of the auction and the escape height.
    pub safety_blocks: u32,
    /// Auction opening price as a multiple of the debt. 30_000 means three times.
    pub auction_start_bps: u32,
    /// Share of interest routed to the endowment.
    pub flywheel_share_bps: u32,
    /// Most a Bitcoin fee may take from a coin, so a spend cannot be drained into fees.
    pub max_btc_fee_bps: u32,
}

impl Params {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.auction_start_bps as u128 <= BPS
            || self.flywheel_share_bps as u128 > BPS
            || self.max_btc_fee_bps as u128 > BPS
            || self.auction_seconds == 0
            || self.min_collateral_sats == 0
        {
            return Err(CoreError::BadParams);
        }
        Ok(())
    }
}

/// What a lender offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfferTerms {
    pub micro_usdc_per_btc: u128,
    pub apr_bps: u32,
    pub term_blocks: u32,
}

impl OfferTerms {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.micro_usdc_per_btc == 0
            || self.micro_usdc_per_btc > MAX_MICRO_USDC_PER_BTC
            || self.apr_bps > MAX_APR_BPS
            || self.term_blocks == 0
        {
            return Err(CoreError::BadOffer);
        }
        Ok(())
    }
}

/// A loan's fixed terms. Nothing here changes after it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoanTerms {
    pub principal: u128,
    pub interest: u128,
    pub due_height: u32,
}

impl LoanTerms {
    /// The amount that clears the loan.
    pub fn debt(&self) -> u128 {
        self.principal + self.interest
    }
}

/// Where the money from clearing a loan goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    pub to_lender: u128,
    pub to_flywheel: u128,
    pub to_borrower: u128,
}

impl Split {
    pub fn total(&self) -> u128 {
        self.to_lender + self.to_flywheel + self.to_borrower
    }
}

/// Where a loan stands against the Bitcoin clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Not yet due, or still inside the grace period. Nothing can happen to the collateral.
    Protected,
    /// Past grace with enough blocks left to run an auction safely.
    Auctionable,
    /// So close to the escape height that an auction could be raced by the owner's path.
    /// The lender's only move is to take the coins straight away.
    TooLateForAuction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    BadParams,
    BadOffer,
    ZeroPrincipal,
    CollateralTooSmall,
    OverLtv,
    InsufficientOfferFunds,
    /// The loan's default process would not finish before the owner's path opens.
    TimelineTooTight,
    Overflow,
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for CoreError {}

/// The most an offer will lend against a coin, rounded down.
pub fn max_principal(collateral_sats: u64, micro_usdc_per_btc: u128) -> u128 {
    collateral_sats as u128 * micro_usdc_per_btc / SATS_PER_BTC
}

/// Simple interest for the whole term, rounded up so a lender never loses a fraction.
/// It is fixed at opening, so a borrower knows the exact debt on day one.
pub fn interest_for(principal: u128, apr_bps: u32, term_blocks: u32) -> Result<u128, CoreError> {
    let numerator = principal
        .checked_mul(apr_bps as u128)
        .and_then(|v| v.checked_mul(term_blocks as u128))
        .ok_or(CoreError::Overflow)?;
    Ok(numerator.div_ceil(BPS * BLOCKS_PER_YEAR))
}

/// The last block by which the loan's whole default process must have finished, measured
/// from `due_height`. It is what the escape height has to clear.
pub fn latest_settlement_height(params: &Params, due_height: u32) -> Option<u32> {
    due_height
        .checked_add(params.grace_blocks)?
        .checked_add(params.auction_blocks)?
        .checked_add(params.safety_blocks)
}

/// Checks a requested loan and fixes its terms.
///
/// The timeline check is what protects a lender from the escape path: a loan can only
/// open if due date, grace, auction and safety margin all fit before the owner's path
/// unlocks. `tip` is the current Bitcoin height from the light client.
pub fn open_loan(
    params: &Params,
    offer: &OfferTerms,
    offer_available: u128,
    collateral_sats: u64,
    principal: u128,
    tip: u32,
    escape_height: u32,
) -> Result<LoanTerms, CoreError> {
    offer.validate()?;
    if principal == 0 {
        return Err(CoreError::ZeroPrincipal);
    }
    if collateral_sats < params.min_collateral_sats {
        return Err(CoreError::CollateralTooSmall);
    }
    if principal > max_principal(collateral_sats, offer.micro_usdc_per_btc) {
        return Err(CoreError::OverLtv);
    }
    if principal > offer_available {
        return Err(CoreError::InsufficientOfferFunds);
    }
    let due_height = tip
        .checked_add(offer.term_blocks)
        .ok_or(CoreError::TimelineTooTight)?;
    let latest = latest_settlement_height(params, due_height).ok_or(CoreError::TimelineTooTight)?;
    if latest > escape_height {
        return Err(CoreError::TimelineTooTight);
    }
    Ok(LoanTerms {
        principal,
        interest: interest_for(principal, offer.apr_bps, offer.term_blocks)?,
        due_height,
    })
}

/// Splits a repayment: the lender gets principal and interest, less a share of the
/// interest for the endowment. A borrower's repayment returns nothing to the borrower.
pub fn repayment_split(params: &Params, loan: &LoanTerms) -> Split {
    let to_flywheel = loan.interest * params.flywheel_share_bps as u128 / BPS;
    Split {
        to_lender: loan.debt() - to_flywheel,
        to_flywheel,
        to_borrower: 0,
    }
}

/// Where the loan stands at Bitcoin height `tip`.
pub fn stage(params: &Params, loan: &LoanTerms, tip: u32, escape_height: u32) -> Stage {
    let grace_end = loan.due_height.saturating_add(params.grace_blocks);
    if tip <= grace_end {
        return Stage::Protected;
    }
    let auction_end = tip
        .saturating_add(params.auction_blocks)
        .saturating_add(params.safety_blocks);
    if auction_end > escape_height {
        Stage::TooLateForAuction
    } else {
        Stage::Auctionable
    }
}

/// Opening price of the auction: a multiple of the debt, since nothing here knows the
/// market price. It only has to start above any sensible market value.
pub fn auction_start_price(params: &Params, debt: u128) -> u128 {
    debt.saturating_mul(params.auction_start_bps as u128) / BPS
}

/// The current auction price, falling in a straight line from the opening price to the
/// debt. Returns `None` once the auction is over.
pub fn auction_price(params: &Params, debt: u128, elapsed_seconds: u64) -> Option<u128> {
    if elapsed_seconds >= params.auction_seconds {
        return None;
    }
    let start = auction_start_price(params, debt);
    let range = start - debt;
    let drop = range * elapsed_seconds as u128 / params.auction_seconds as u128;
    Some(start - drop)
}

/// Splits a winning bid. The lender is paid as in a repayment, and everything above the
/// debt goes back to the borrower: a default costs the interest, not the whole coin.
pub fn bid_split(params: &Params, loan: &LoanTerms, price: u128) -> Split {
    let base = repayment_split(params, loan);
    Split {
        to_borrower: price.saturating_sub(loan.debt()),
        ..base
    }
}

/// Most a Bitcoin fee may take from a coin.
pub fn max_btc_fee(params: &Params, collateral_sats: u64) -> u64 {
    (collateral_sats as u128 * params.max_btc_fee_bps as u128 / BPS) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params {
            min_collateral_sats: 10_000,
            grace_blocks: 144,
            auction_seconds: 86_400,
            auction_blocks: 288,
            safety_blocks: 1_008,
            auction_start_bps: 30_000,
            flywheel_share_bps: 1_000,
            max_btc_fee_bps: 500,
        }
    }

    fn offer() -> OfferTerms {
        OfferTerms {
            micro_usdc_per_btc: 40_000 * 1_000_000,
            apr_bps: 900,
            term_blocks: 4_320,
        }
    }

    const USDC: u128 = 1_000_000;
    const ONE_BTC: u64 = 100_000_000;

    fn loan() -> LoanTerms {
        open_loan(
            &params(),
            &offer(),
            100_000 * USDC,
            ONE_BTC,
            40_000 * USDC,
            1_000,
            20_000,
        )
        .unwrap()
    }

    /// Small deterministic generator, so a failing sweep reproduces exactly.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn upto(&mut self, max: u64) -> u64 {
            self.next() % (max + 1)
        }
    }

    #[test]
    fn example_loan_from_the_pitch() {
        // $40,000 against one BTC, 30 days, 9% APR.
        let l = loan();
        assert_eq!(l.principal, 40_000 * USDC);
        assert_eq!(l.due_height, 5_320);
        // 40,000 * 9% * 4320 / 52560 = 295.89..., rounded up to the micro-dollar.
        assert_eq!(l.interest, 295_890_411);
        assert_eq!(l.debt(), 40_295_890_411);
    }

    #[test]
    fn max_principal_scales_with_collateral_and_rounds_down() {
        let price = 40_000 * USDC;
        assert_eq!(max_principal(ONE_BTC, price), 40_000 * USDC);
        assert_eq!(max_principal(ONE_BTC / 2, price), 20_000 * USDC);
        assert_eq!(max_principal(1, price), 400);
        assert_eq!(max_principal(1, 1), 0);
        assert_eq!(max_principal(0, price), 0);
    }

    #[test]
    fn interest_rounds_up_and_scales() {
        assert_eq!(interest_for(0, 900, 100).unwrap(), 0);
        assert_eq!(interest_for(1, 1, 1).unwrap(), 1, "a lender never earns zero");
        // A year at 10% on 1,000 dollars is exactly 100.
        assert_eq!(
            interest_for(1_000 * USDC, 1_000, BLOCKS_PER_YEAR as u32).unwrap(),
            100 * USDC
        );
    }

    #[test]
    fn interest_overflow_is_an_error_not_a_wrap() {
        assert_eq!(
            interest_for(u128::MAX, 100_000, 1_000),
            Err(CoreError::Overflow)
        );
    }

    #[test]
    fn refuses_a_loan_above_the_offered_price() {
        let r = open_loan(
            &params(),
            &offer(),
            100_000 * USDC,
            ONE_BTC,
            40_000 * USDC + 1,
            1_000,
            20_000,
        );
        assert_eq!(r, Err(CoreError::OverLtv));
    }

    #[test]
    fn refuses_more_than_the_offer_has_left() {
        let r = open_loan(
            &params(),
            &offer(),
            10 * USDC,
            ONE_BTC,
            11 * USDC,
            1_000,
            20_000,
        );
        assert_eq!(r, Err(CoreError::InsufficientOfferFunds));
    }

    #[test]
    fn refuses_a_zero_loan_and_dust_collateral() {
        let p = params();
        assert_eq!(
            open_loan(&p, &offer(), USDC, ONE_BTC, 0, 1_000, 20_000),
            Err(CoreError::ZeroPrincipal)
        );
        assert_eq!(
            open_loan(&p, &offer(), USDC, 9_999, 1, 1_000, 20_000),
            Err(CoreError::CollateralTooSmall)
        );
    }

    #[test]
    fn the_timeline_check_is_exact_to_the_block() {
        // 1000 tip + 4320 term + 144 grace + 288 auction + 1008 safety = 6760.
        let p = params();
        let ok = open_loan(&p, &offer(), USDC, ONE_BTC, USDC, 1_000, 6_760);
        assert!(ok.is_ok());
        let bad = open_loan(&p, &offer(), USDC, ONE_BTC, USDC, 1_000, 6_759);
        assert_eq!(bad, Err(CoreError::TimelineTooTight));
    }

    #[test]
    fn a_timeline_that_overflows_is_refused() {
        let far = OfferTerms {
            term_blocks: u32::MAX,
            ..offer()
        };
        let r = open_loan(&params(), &far, USDC, ONE_BTC, USDC, 1_000, 20_000);
        assert_eq!(r, Err(CoreError::TimelineTooTight));
    }

    #[test]
    fn bad_offers_are_refused() {
        for bad in [
            OfferTerms {
                micro_usdc_per_btc: 0,
                ..offer()
            },
            OfferTerms {
                micro_usdc_per_btc: MAX_MICRO_USDC_PER_BTC + 1,
                ..offer()
            },
            OfferTerms {
                apr_bps: MAX_APR_BPS + 1,
                ..offer()
            },
            OfferTerms {
                term_blocks: 0,
                ..offer()
            },
        ] {
            assert_eq!(bad.validate(), Err(CoreError::BadOffer));
        }
    }

    #[test]
    fn bad_params_are_refused() {
        let good = params();
        assert!(good.validate().is_ok());
        for bad in [
            Params {
                auction_start_bps: 10_000,
                ..good
            },
            Params {
                flywheel_share_bps: 10_001,
                ..good
            },
            Params {
                max_btc_fee_bps: 10_001,
                ..good
            },
            Params {
                auction_seconds: 0,
                ..good
            },
            Params {
                min_collateral_sats: 0,
                ..good
            },
        ] {
            assert_eq!(bad.validate(), Err(CoreError::BadParams));
        }
    }

    #[test]
    fn repayment_pays_the_lender_and_a_share_of_interest_to_the_flywheel() {
        let l = loan();
        let s = repayment_split(&params(), &l);
        assert_eq!(s.to_flywheel, 29_589_041);
        assert_eq!(s.to_lender, l.debt() - 29_589_041);
        assert_eq!(s.to_borrower, 0);
        assert_eq!(s.total(), l.debt());
    }

    #[test]
    fn stage_walks_the_timeline_in_order() {
        let p = params();
        let l = loan(); // due 5320, grace ends 5464
        assert_eq!(stage(&p, &l, 1_000, 20_000), Stage::Protected);
        assert_eq!(stage(&p, &l, 5_320, 20_000), Stage::Protected);
        assert_eq!(stage(&p, &l, 5_464, 20_000), Stage::Protected, "last grace block");
        assert_eq!(stage(&p, &l, 5_465, 20_000), Stage::Auctionable);
        // 288 auction + 1008 safety: from tip 18704 on, an auction no longer fits.
        assert_eq!(stage(&p, &l, 18_704, 20_000), Stage::Auctionable);
        assert_eq!(stage(&p, &l, 18_705, 20_000), Stage::TooLateForAuction);
    }

    #[test]
    fn a_dip_alone_can_never_touch_the_collateral() {
        // The whole point: stage takes no price. Before grace ends the answer is
        // Protected for every block, and there is no argument a crash could change.
        let p = params();
        let l = loan();
        for tip in 0..=5_464 {
            assert_eq!(stage(&p, &l, tip, 20_000), Stage::Protected);
        }
    }

    #[test]
    fn auction_price_runs_from_the_opening_price_down_to_the_debt() {
        let p = params();
        let debt = 1_000 * USDC;
        assert_eq!(auction_price(&p, debt, 0), Some(3_000 * USDC));
        assert_eq!(auction_price(&p, debt, 43_200), Some(2_000 * USDC));
        assert_eq!(
            auction_price(&p, debt, 86_399),
            Some(1_000 * USDC + 23_149)
        );
        assert_eq!(auction_price(&p, debt, 86_400), None);
        assert_eq!(auction_price(&p, debt, u64::MAX), None);
    }

    #[test]
    fn a_winning_bid_returns_the_surplus_to_the_borrower() {
        let p = params();
        let l = loan();
        let s = bid_split(&p, &l, 70_000 * USDC);
        assert_eq!(s.to_borrower, 70_000 * USDC - l.debt());
        assert_eq!(s.total(), 70_000 * USDC);
        assert_eq!(s.to_lender + s.to_flywheel, l.debt());
    }

    #[test]
    fn btc_fee_cap_is_a_share_of_the_coin() {
        assert_eq!(max_btc_fee(&params(), 100_000), 5_000);
        assert_eq!(max_btc_fee(&params(), 21_000_000 * ONE_BTC), 105_000_000_000_000);
    }

    // Sweeps. Each checks an invariant across many generated inputs.

    fn random_params(r: &mut Rng) -> Params {
        Params {
            min_collateral_sats: 1 + r.upto(100_000),
            grace_blocks: r.upto(1_000) as u32,
            auction_seconds: 1 + r.upto(1_000_000),
            auction_blocks: r.upto(1_000) as u32,
            safety_blocks: r.upto(5_000) as u32,
            auction_start_bps: 10_001 + r.upto(90_000) as u32,
            flywheel_share_bps: r.upto(10_000) as u32,
            max_btc_fee_bps: r.upto(10_000) as u32,
        }
    }

    fn random_offer(r: &mut Rng) -> OfferTerms {
        OfferTerms {
            micro_usdc_per_btc: 1 + r.upto(MAX_MICRO_USDC_PER_BTC as u64) as u128,
            apr_bps: r.upto(MAX_APR_BPS as u64) as u32,
            term_blocks: 1 + r.upto(100_000) as u32,
        }
    }

    #[test]
    fn sweep_every_accepted_loan_fits_before_the_escape_path() {
        let mut r = Rng(0x5eed_0001);
        let mut accepted = 0;
        for _ in 0..200_000 {
            let p = random_params(&mut r);
            let o = random_offer(&mut r);
            let sats = r.upto(2_100_000_000_000_000);
            let max = max_principal(sats, o.micro_usdc_per_btc);
            let principal = if max == 0 { 1 } else { 1 + r.next() as u128 % max };
            let tip = r.upto(6_000_000) as u32;
            let escape = tip + r.upto(200_000) as u32;
            if let Ok(l) = open_loan(&p, &o, u128::MAX, sats, principal, tip, escape) {
                accepted += 1;
                assert!(l.due_height > tip);
                assert_eq!(l.due_height, tip + o.term_blocks);
                let last = l.due_height + p.grace_blocks + p.auction_blocks + p.safety_blocks;
                assert!(last <= escape, "lender could be raced by the escape path");
                assert!(l.principal <= max);
            }
        }
        assert!(accepted > 1_000, "sweep barely exercised the rule: {accepted}");
    }

    #[test]
    fn sweep_money_is_conserved_exactly() {
        let mut r = Rng(0x5eed_0002);
        for _ in 0..200_000 {
            let p = random_params(&mut r);
            let l = LoanTerms {
                principal: 1 + r.upto(1_000_000_000_000_000) as u128,
                interest: r.upto(100_000_000_000_000) as u128,
                due_height: 1,
            };
            let repaid = repayment_split(&p, &l);
            assert_eq!(repaid.total(), l.debt(), "repayment created or lost money");
            assert!(repaid.to_flywheel <= l.interest, "flywheel touched principal");
            assert!(repaid.to_lender >= l.principal, "lender lost principal");

            let price = l.debt() + r.upto(1_000_000_000_000_000) as u128;
            let bid = bid_split(&p, &l, price);
            assert_eq!(bid.total(), price, "auction created or lost money");
            assert!(bid.to_lender >= l.principal);
        }
    }

    #[test]
    fn sweep_auction_price_only_falls_and_stays_above_the_debt() {
        let mut r = Rng(0x5eed_0003);
        for _ in 0..2_000 {
            let p = random_params(&mut r);
            let debt = 1 + r.upto(1_000_000_000_000_000) as u128;
            let start = auction_start_price(&p, debt);
            let mut last = u128::MAX;
            for step in 0..200u64 {
                let t = p.auction_seconds * step / 200;
                let price = auction_price(&p, debt, t).unwrap();
                assert!(price <= last, "price rose");
                assert!(price >= debt, "price fell below the debt");
                assert!(price <= start, "price above the opening price");
                last = price;
            }
            assert_eq!(auction_price(&p, debt, p.auction_seconds), None);
        }
    }

    #[test]
    fn sweep_stage_is_a_one_way_street() {
        let mut r = Rng(0x5eed_0004);
        for _ in 0..2_000 {
            let p = random_params(&mut r);
            let l = LoanTerms {
                principal: 1,
                interest: 1,
                due_height: r.upto(100_000) as u32,
            };
            let escape = l.due_height + r.upto(10_000) as u32;
            let rank = |s| match s {
                Stage::Protected => 0,
                Stage::Auctionable => 1,
                Stage::TooLateForAuction => 2,
            };
            let mut last = 0;
            for tip in (0..escape + 2_000).step_by(37) {
                let now = rank(stage(&p, &l, tip, escape));
                assert!(now >= last, "stage moved backwards");
                last = now;
            }
        }
    }
}
