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

/// Half of Bitcoin's ten minutes, used to test that an auction fits in its blocks.
const SECONDS_PER_FAST_BLOCK: u64 = 300;

/// Bitcoin nodes accept a header stamped up to two hours ahead of their own clock.
const MAX_HEADER_DRIFT_SECONDS: u64 = 7_200;

/// About the smallest fee nodes will relay for a vault spend.
const MIN_RELAY_FEE_SATS: u128 = 200;

/// Limits that keep the sale arithmetic inside a u128.
const MAX_SALE_START_RATE: u128 = 1 << 96;
const MAX_SALE_SECONDS: u64 = 1 << 31;
const MAX_SALE_HALVINGS: u32 = 64;

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
    /// Blocks in which anyone can start the auction. A loan refuses to open without this
    /// window, because with none a default skips the auction and the borrower's surplus.
    pub start_window_blocks: u32,
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
    /// Oldest Bitcoin header the light client may hold when a loan opens or an auction
    /// starts. Past this it has probably stopped following Bitcoin.
    pub max_tip_age_seconds: u64,
}

impl Params {
    pub fn validate(&self) -> Result<(), CoreError> {
        let min_fee_room = self.min_collateral_sats as u128 * self.max_btc_fee_bps as u128 / BPS;
        if self.auction_start_bps as u128 <= BPS
            || self.flywheel_share_bps as u128 > BPS
            || self.max_btc_fee_bps as u128 > BPS
            || self.auction_seconds == 0
            || self.min_collateral_sats == 0
            || self.start_window_blocks == 0
            || self.safety_blocks == 0
            || self.auction_blocks == 0
            || self.max_tip_age_seconds == 0
            // A frozen tip hides real blocks, and its age is read from a time miners choose.
            // The most it can hide, with their leeway, must stay below the safety margin,
            // or a borrower could open a loan and race the lender.
            || self.max_tip_age_seconds.saturating_add(MAX_HEADER_DRIFT_SECONDS)
                >= (self.safety_blocks as u64) * SECONDS_PER_FAST_BLOCK
            // These settings can never change, so bad ones would be permanent. An auction
            // has to fit in its blocks even if Bitcoin runs at twice its usual speed.
            || (self.auction_blocks as u64) * SECONDS_PER_FAST_BLOCK < self.auction_seconds
            // The smallest coin must still be able to pay a relayable fee.
            || min_fee_room < MIN_RELAY_FEE_SATS
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
    /// Where the auction opens if this loan defaults.
    pub auction_start: u128,
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
    BadAuctionOpen,
    BadSale,
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
        .checked_add(params.start_window_blocks)?
        .checked_add(params.auction_blocks)?
        .checked_add(params.safety_blocks)
}

/// Checks a requested loan and fixes its terms.
///
/// The timeline check is what protects a lender from the escape path: a loan can only
/// open if due date, grace, start window, auction and safety margin all fit before the
/// owner's path unlocks. `tip` is the current Bitcoin height from the light client.
///
/// `auction_open_per_btc` is the borrower's own opening price, in micro-USDC per BTC, if
/// this loan ever defaults. The contract knows no market price, so the person with the
/// most to lose names it. Too low costs them their surplus. Far too high leaves bidders
/// little time near the real price, which also falls on them: the lender's floor stays
/// at the debt, and the auction takes the same time.
#[allow(clippy::too_many_arguments)]
pub fn open_loan(
    params: &Params,
    offer: &OfferTerms,
    offer_available: u128,
    collateral_sats: u64,
    principal: u128,
    auction_open_per_btc: u128,
    tip: u32,
    escape_height: u32,
) -> Result<LoanTerms, CoreError> {
    offer.validate()?;
    if auction_open_per_btc > MAX_MICRO_USDC_PER_BTC {
        return Err(CoreError::BadAuctionOpen);
    }
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
    let interest = interest_for(principal, offer.apr_bps, offer.term_blocks)?;
    let debt = principal + interest;
    Ok(LoanTerms {
        principal,
        interest,
        due_height,
        auction_start: minimum_auction_start(params, debt)
            .max(max_principal(collateral_sats, auction_open_per_btc)),
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

/// The lowest an auction may open: a multiple of the debt, so there is always a range to
/// fall through. The real opening price is the borrower's own, if that is higher.
pub fn minimum_auction_start(params: &Params, debt: u128) -> u128 {
    debt.saturating_mul(params.auction_start_bps as u128) / BPS
}

/// The current auction price, falling in a straight line from the opening price to the
/// debt. Returns `None` once the auction is over.
pub fn auction_price(params: &Params, loan: &LoanTerms, elapsed_seconds: u64) -> Option<u128> {
    if elapsed_seconds >= params.auction_seconds {
        return None;
    }
    let start = loan.auction_start;
    let range = start - loan.debt();
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

/// Whether the light client's newest header is recent enough to trust its height.
///
/// If the relayer stops, the height freezes while Bitcoin moves on, and every check
/// against the escape height becomes too generous. Miners may stamp a header ahead of the
/// clock, so a time in the future counts as age zero. Repaying never reads this: a stale
/// light client must never stop a borrower from paying.
pub fn tip_is_fresh(params: &Params, header_time: u32, now_seconds: u64) -> bool {
    now_seconds.saturating_sub(header_time as u64) <= params.max_tip_age_seconds
}

/// Checks the settings of `sale_rate`.
pub fn validate_sale(start_rate: u128, halvings: u32, seconds: u64) -> Result<(), CoreError> {
    if seconds == 0
        || seconds > MAX_SALE_SECONDS
        || halvings == 0
        || halvings > MAX_SALE_HALVINGS
        || start_rate > MAX_SALE_START_RATE
        || start_rate >> halvings == 0
    {
        return Err(CoreError::BadSale);
    }
    Ok(())
}

/// The rate of a Dutch sale that halves `halvings` times over `seconds`, or `None` once
/// it is over. Halving moves the rate by the same percentage each minute, so a wide range
/// can cover any likely market price without skipping past it.
///
/// A sale keeps no memory of the last one. Letting a sale open near the last fill would
/// let a small buyer walk the price down, one cheap sale after another.
pub fn sale_rate(start_rate: u128, halvings: u32, seconds: u64, elapsed: u64) -> Option<u128> {
    if elapsed >= seconds {
        return None;
    }
    let seconds = seconds as u128;
    let scaled = elapsed as u128 * halvings as u128;
    let base = start_rate >> (scaled / seconds);
    Some(base - (base / 2) * (scaled % seconds) / seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params {
            min_collateral_sats: 10_000,
            grace_blocks: 144,
            start_window_blocks: 144,
            auction_seconds: 86_400,
            auction_blocks: 288,
            safety_blocks: 1_008,
            auction_start_bps: 30_000,
            flywheel_share_bps: 1_000,
            max_btc_fee_bps: 500,
            max_tip_age_seconds: 7_200,
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
            0,
            1_000,
            20_000,
        )
        .unwrap()
    }

    /// A loan that owes `debt` and opens its auction at three times that.
    fn owing(debt: u128) -> LoanTerms {
        LoanTerms {
            principal: debt,
            interest: 0,
            due_height: 1,
            auction_start: debt * 3,
        }
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
            0,
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
            0,
            1_000,
            20_000,
        );
        assert_eq!(r, Err(CoreError::InsufficientOfferFunds));
    }

    #[test]
    fn refuses_a_zero_loan_and_dust_collateral() {
        let p = params();
        assert_eq!(
            open_loan(&p, &offer(), USDC, ONE_BTC, 0, 0, 1_000, 20_000),
            Err(CoreError::ZeroPrincipal)
        );
        assert_eq!(
            open_loan(&p, &offer(), USDC, 9_999, 1, 0, 1_000, 20_000),
            Err(CoreError::CollateralTooSmall)
        );
    }

    #[test]
    fn the_timeline_check_is_exact_to_the_block() {
        // 1000 tip + 4320 term + 144 grace + 144 window + 288 auction + 1008 safety = 6904.
        let p = params();
        let ok = open_loan(&p, &offer(), USDC, ONE_BTC, USDC, 0, 1_000, 6_904);
        assert!(ok.is_ok());
        let bad = open_loan(&p, &offer(), USDC, ONE_BTC, USDC, 0, 1_000, 6_903);
        assert_eq!(bad, Err(CoreError::TimelineTooTight));
    }

    #[test]
    fn a_timeline_that_overflows_is_refused() {
        let far = OfferTerms {
            term_blocks: u32::MAX,
            ..offer()
        };
        let r = open_loan(&params(), &far, USDC, ONE_BTC, USDC, 0, 1_000, 20_000);
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
            Params {
                start_window_blocks: 0,
                ..good
            },
            Params {
                safety_blocks: 0,
                ..good
            },
            Params {
                auction_blocks: 0,
                ..good
            },
            // An auction that cannot fit in its blocks, even at twice Bitcoin's speed.
            Params {
                auction_blocks: 287,
                ..good
            },
            Params {
                max_tip_age_seconds: 0,
                ..good
            },
            // A frozen tip could hide more blocks than the safety margin holds, once a
            // miner's two hours of leeway are counted. Exactly at the limit is too close.
            Params {
                safety_blocks: 48,
                max_tip_age_seconds: 7_200,
                ..good
            },
            // The smallest coin could not pay a fee nodes will relay.
            Params {
                min_collateral_sats: 1_000,
                max_btc_fee_bps: 100,
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
        let l = owing(1_000 * USDC);
        assert_eq!(auction_price(&p, &l, 0), Some(3_000 * USDC));
        assert_eq!(auction_price(&p, &l, 43_200), Some(2_000 * USDC));
        assert_eq!(auction_price(&p, &l, 86_399), Some(1_000 * USDC + 23_149));
        assert_eq!(auction_price(&p, &l, 86_400), None);
        assert_eq!(auction_price(&p, &l, u64::MAX), None);
    }

    #[test]
    fn a_cautious_borrower_keeps_their_surplus() {
        // 1 BTC worth about $100,000, with only $10,000 borrowed. If the auction opened at
        // three times the debt, a bot could take a $100,000 coin for about $30,000 at once.
        // The borrower names the opening price, so the coin has room to find its value.
        let p = params();
        let open = 150_000 * USDC;
        let l = open_loan(&p, &offer(), 100_000 * USDC, ONE_BTC, 10_000 * USDC, open, 1_000, 20_000).unwrap();
        assert_eq!(l.auction_start, 150_000 * USDC);
        assert_eq!(auction_price(&p, &l, 0), Some(150_000 * USDC));

        // Halfway down it is still well above three times the debt.
        let halfway = auction_price(&p, &l, 43_200).unwrap();
        assert!(halfway > 80_000 * USDC);

        // A bidder at the market price pays it, and the borrower gets everything above the debt.
        let s = bid_split(&p, &l, 100_000 * USDC);
        assert_eq!(s.to_borrower, 100_000 * USDC - l.debt());
    }

    #[test]
    fn the_opening_price_scales_with_the_coin_not_the_debt() {
        let p = params();
        let half = open_loan(&p, &offer(), 100_000 * USDC, ONE_BTC / 2, 100 * USDC, 150_000 * USDC, 1_000, 20_000).unwrap();
        assert_eq!(half.auction_start, 75_000 * USDC);
    }

    #[test]
    fn a_low_opening_price_cannot_go_under_the_minimum() {
        // A range above the debt always exists, so the lender's floor is never the opening.
        let p = params();
        let l = open_loan(&p, &offer(), 100_000 * USDC, ONE_BTC, 40_000 * USDC, 1, 1_000, 20_000).unwrap();
        assert_eq!(l.auction_start, l.debt() * 3);
    }

    #[test]
    fn an_absurd_opening_price_is_refused() {
        let r = open_loan(
            &params(),
            &offer(),
            100_000 * USDC,
            ONE_BTC,
            USDC,
            MAX_MICRO_USDC_PER_BTC + 1,
            1_000,
            20_000,
        );
        assert_eq!(r, Err(CoreError::BadAuctionOpen));
    }

    #[test]
    fn the_safety_margin_must_outlast_a_frozen_tip() {
        let p = Params {
            safety_blocks: 49,
            max_tip_age_seconds: 7_200,
            ..params()
        };
        assert_eq!(p.validate(), Ok(()));
    }

    #[test]
    fn a_frozen_light_client_is_noticed() {
        let p = params();
        let now = 1_000_000;
        assert!(tip_is_fresh(&p, now as u32 - 121, now));
        assert!(tip_is_fresh(&p, now as u32 - 7_200, now));
        assert!(!tip_is_fresh(&p, now as u32 - 7_201, now));
        // Testnet headers run ahead of the clock, which must not underflow.
        assert!(tip_is_fresh(&p, now as u32 + 6_500, now));
    }

    #[test]
    fn a_sale_halves_on_schedule() {
        assert_eq!(sale_rate(1_600, 4, 4_000, 0), Some(1_600));
        assert_eq!(sale_rate(1_600, 4, 4_000, 500), Some(1_200));
        assert_eq!(sale_rate(1_600, 4, 4_000, 1_000), Some(800));
        assert_eq!(sale_rate(1_600, 4, 4_000, 2_000), Some(400));
        assert_eq!(sale_rate(1_600, 4, 4_000, 3_000), Some(200));
        assert_eq!(sale_rate(1_600, 4, 4_000, 3_999), Some(101));
        assert_eq!(sale_rate(1_600, 4, 4_000, 4_000), None);
        assert_eq!(sale_rate(1_600, 4, 4_000, u64::MAX), None);
    }

    #[test]
    fn the_planned_sale_covers_every_likely_near_price() {
        // 16 NEAR per dollar down to 1/256 NEAR per dollar, in yoctoNEAR per micro-USDC:
        // NEAR priced anywhere from about six cents to 256 dollars.
        let start = 16 * 10u128.pow(24) / 1_000_000;
        assert_eq!(validate_sale(start, 12, 86_400), Ok(()));
        assert_eq!(sale_rate(start, 12, 86_400, 0), Some(start));
        let last = sale_rate(start, 12, 86_400, 86_399).unwrap();
        assert!(last >= start >> 12);
        assert!(last < (start >> 12) + (start >> 12) / 1_000, "the last rate is near the end");
    }

    #[test]
    fn bad_sales_are_refused() {
        assert_eq!(validate_sale(1_600, 4, 0), Err(CoreError::BadSale));
        assert_eq!(validate_sale(1_600, 0, 100), Err(CoreError::BadSale));
        assert_eq!(validate_sale(1_600, 11, 100), Err(CoreError::BadSale), "ends at zero");
        assert_eq!(validate_sale(u128::MAX, 4, 100), Err(CoreError::BadSale));
        assert_eq!(validate_sale(1_600, 4, u64::MAX), Err(CoreError::BadSale));
    }

    #[test]
    fn sweep_a_sale_only_falls_and_stays_in_range() {
        let mut r = Rng(0x5a1e_5a1e);
        for _ in 0..2_000 {
            let halvings = 1 + r.upto(63) as u32;
            let start = (1 + r.upto(u64::MAX - 1) as u128) << halvings.min(32);
            let seconds = 1 + r.upto(1_000_000);
            if validate_sale(start, halvings, seconds).is_err() {
                continue;
            }
            let mut last = u128::MAX;
            for step in 0..300u64 {
                let elapsed = (seconds as u128 * step as u128 / 300) as u64;
                let rate = sale_rate(start, halvings, seconds, elapsed).unwrap();
                assert!(rate <= last, "the rate rose");
                assert!(rate <= start);
                assert!(rate >= start >> halvings, "the rate fell below the end");
                last = rate;
            }
            assert_eq!(sale_rate(start, halvings, seconds, seconds), None);
        }
    }

    #[test]
    fn the_tightest_loan_allowed_still_has_a_window_to_start_an_auction() {
        // Without the start window, this exact fit went straight from Protected to
        // TooLateForAuction: no auction, and no surplus for the borrower.
        let p = params();
        let escape = 6_904;
        let l = open_loan(&p, &offer(), USDC, ONE_BTC, USDC, 0, 1_000, escape).unwrap();
        let grace_end = l.due_height + p.grace_blocks;
        assert_eq!(stage(&p, &l, grace_end, escape), Stage::Protected);
        for tip in grace_end + 1..=grace_end + p.start_window_blocks {
            assert_eq!(stage(&p, &l, tip, escape), Stage::Auctionable, "tip {tip}");
        }
        assert_eq!(
            stage(&p, &l, grace_end + p.start_window_blocks + 1, escape),
            Stage::TooLateForAuction
        );
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
            start_window_blocks: 1 + r.upto(500) as u32,
            auction_seconds: 1 + r.upto(1_000_000),
            auction_blocks: r.upto(1_000) as u32,
            safety_blocks: r.upto(5_000) as u32,
            auction_start_bps: 10_001 + r.upto(90_000) as u32,
            flywheel_share_bps: r.upto(10_000) as u32,
            max_btc_fee_bps: r.upto(10_000) as u32,
            max_tip_age_seconds: 1 + r.upto(100_000),
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
            let open = r.upto(MAX_MICRO_USDC_PER_BTC as u64) as u128;
            if let Ok(l) = open_loan(&p, &o, u128::MAX, sats, principal, open, tip, escape) {
                accepted += 1;
                assert!(l.due_height > tip);
                assert_eq!(l.due_height, tip + o.term_blocks);
                let last = l.due_height
                    + p.grace_blocks
                    + p.start_window_blocks
                    + p.auction_blocks
                    + p.safety_blocks;
                assert!(last <= escape, "lender could be raced by the escape path");
                assert!(l.principal <= max);
                assert!(l.auction_start >= l.debt(), "the auction opens below the debt");
                let first = l.due_height + p.grace_blocks + 1;
                assert_eq!(
                    stage(&p, &l, first + p.start_window_blocks - 1, escape),
                    Stage::Auctionable,
                    "a loan opened with no window to start its auction"
                );
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
                auction_start: 0,
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
            let start = minimum_auction_start(&p, debt) + r.upto(1_000_000_000_000_000) as u128;
            let l = LoanTerms {
                principal: debt,
                interest: 0,
                due_height: 1,
                auction_start: start,
            };
            let mut last = u128::MAX;
            for step in 0..200u64 {
                let t = p.auction_seconds * step / 200;
                let price = auction_price(&p, &l, t).unwrap();
                assert!(price <= last, "price rose");
                assert!(price >= debt, "price fell below the debt");
                assert!(price <= start, "price above the opening price");
                last = price;
            }
            assert_eq!(auction_price(&p, &l, p.auction_seconds), None);
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
                auction_start: 6,
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
