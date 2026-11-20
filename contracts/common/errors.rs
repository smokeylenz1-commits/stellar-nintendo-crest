//! Shared contract error code ranges.
//!
//! All workspace contracts MUST use these non-overlapping discriminant ranges
//! so that client-side decoding and error presentation stay stable across
//! builds. Do not renumber existing variants: append new variants at the end
//! of their contract's range to avoid shifting discriminants.

/// Market contract error codes (100-199).
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MarketErrorCode {
    Unauthorized = 100,
    MarketNotFound = 101,
    MarketClosed = 102,
    InvalidOutcome = 103,
    InsufficientLiquidity = 104,
    InvalidAmount = 105,
    AlreadyResolved = 106,
    NotResolved = 107,
    InvalidDeadline = 108,
    DisputeWindowClosed = 109,
    InvalidBond = 110,
}

/// Token contract error codes (200-299).
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum TokenErrorCode {
    Unauthorized = 200,
    InsufficientBalance = 201,
    InsufficientAllowance = 202,
    InvalidAmount = 203,
    InvalidRecipient = 204,
    AlreadyInitialized = 205,
    NotInitialized = 206,
    Overflow = 207,
}

/// Leaderboard contract error codes (250-299).
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum LeaderboardErrorCode {
    Unauthorized = 250,
    LeaderboardNotFound = 251,
    InvalidPeriod = 252,
    AlreadyFinalized = 253,
    NotFinalized = 254,
    InvalidScore = 255,
}

/// Referral contract error codes (300-399).
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ReferralErrorCode {
    Unauthorized = 300,
    ReferralNotFound = 301,
    AlreadyRegistered = 302,
    SelfReferral = 303,
    InvalidCode = 304,
    CycleDetected = 305,
    InvalidReward = 306,
}

/// Inclusive start of each contract's error code range.
pub const MARKET_ERROR_RANGE: (u32, u32) = (100, 199);
pub const TOKEN_ERROR_RANGE: (u32, u32) = (200, 249);
pub const LEADERBOARD_ERROR_RANGE: (u32, u32) = (250, 299);
pub const REFERRAL_ERROR_RANGE: (u32, u32) = (300, 399);

#[cfg(test)]
mod tests {
    use super::*;

    fn market_codes() -> [u32; 11] {
        [
            MarketErrorCode::Unauthorized as u32,
            MarketErrorCode::MarketNotFound as u32,
            MarketErrorCode::MarketClosed as u32,
            MarketErrorCode::InvalidOutcome as u32,
            MarketErrorCode::InsufficientLiquidity as u32,
            MarketErrorCode::InvalidAmount as u32,
            MarketErrorCode::AlreadyResolved as u32,
            MarketErrorCode::NotResolved as u32,
            MarketErrorCode::InvalidDeadline as u32,
            MarketErrorCode::DisputeWindowClosed as u32,
            MarketErrorCode::InvalidBond as u32,
        ]
    }

    fn token_codes() -> [u32; 8] {
        [
            TokenErrorCode::Unauthorized as u32,
            TokenErrorCode::InsufficientBalance as u32,
            TokenErrorCode::InsufficientAllowance as u32,
            TokenErrorCode::InvalidAmount as u32,
            TokenErrorCode::InvalidRecipient as u32,
            TokenErrorCode::AlreadyInitialized as u32,
            TokenErrorCode::NotInitialized as u32,
            TokenErrorCode::Overflow as u32,
        ]
    }

    fn leaderboard_codes() -> [u32; 6] {
        [
            LeaderboardErrorCode::Unauthorized as u32,
            LeaderboardErrorCode::LeaderboardNotFound as u32,
            LeaderboardErrorCode::InvalidPeriod as u32,
            LeaderboardErrorCode::AlreadyFinalized as u32,
            LeaderboardErrorCode::NotFinalized as u32,
            LeaderboardErrorCode::InvalidScore as u32,
        ]
    }

    fn referral_codes() -> [u32; 7] {
        [
            ReferralErrorCode::Unauthorized as u32,
            ReferralErrorCode::ReferralNotFound as u32,
            ReferralErrorCode::AlreadyRegistered as u32,
            ReferralErrorCode::SelfReferral as u32,
            ReferralErrorCode::InvalidCode as u32,
            ReferralErrorCode::CycleDetected as u32,
            ReferralErrorCode::InvalidReward as u32,
        ]
    }

    fn assert_in_range(codes: &[u32], range: (u32, u32)) {
        for &code in codes {
            assert!(
                code >= range.0 && code <= range.1,
                "code {code} outside range {range:?}"
            );
        }
    }

    #[test]
    fn discriminants_are_stable() {
        // Regression: these values must not shift across builds.
        assert_eq!(market_codes(), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
        assert_eq!(token_codes(), [200, 201, 202, 203, 204, 205, 206, 207]);
        assert_eq!(leaderboard_codes(), [250, 251, 252, 253, 254, 255]);
        assert_eq!(referral_codes(), [300, 301, 302, 303, 304, 305, 306]);
    }

    #[test]
    fn ranges_do_not_overlap() {
        assert_in_range(&market_codes(), MARKET_ERROR_RANGE);
        assert_in_range(&token_codes(), TOKEN_ERROR_RANGE);
        assert_in_range(&leaderboard_codes(), LEADERBOARD_ERROR_RANGE);
        assert_in_range(&referral_codes(), REFERRAL_ERROR_RANGE);

        let ranges = [
            MARKET_ERROR_RANGE,
            TOKEN_ERROR_RANGE,
            LEADERBOARD_ERROR_RANGE,
            REFERRAL_ERROR_RANGE,
        ];
        for (i, a) in ranges.iter().enumerate() {
            for b in ranges.iter().skip(i + 1) {
                assert!(a.1 < b.0 || b.1 < a.0, "ranges {a:?} and {b:?} overlap");
            }
        }
    }
}
