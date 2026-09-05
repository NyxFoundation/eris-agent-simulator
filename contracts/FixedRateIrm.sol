// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title FixedRateIrm
/// @notice The interest-rate model a `SimpleLending` market points at. It is **ornamental and says
///         so** (issue #40): an epoch is 360 blocks x 2s = 12 minutes, and 3%/yr over 12 minutes is
///         0.00007%. Yield cannot bait anybody at this epoch length, so the baits that work here are
///         the immediate ones — an apparently favourable rate on the *quoted* number, leverage, and
///         the liquidation incentive.
///
///         It ships anyway because a market's parameters have to be complete for the venue to be a
///         real lending market, and because the advertised APR is itself a lie an adversary can
///         tell: nothing checks that the rate an IRM reports is the rate it charges.
/// @dev The rate is per second in WAD. `ratePerSecond = apr * 1e18 / 365 days`.
contract FixedRateIrm {
    uint256 public immutable ratePerSecond;
    /// The APR this was constructed from, so a reader does not have to invert the per-second rate.
    uint256 public immutable aprBps;

    constructor(uint256 aprBps_) {
        aprBps = aprBps_;
        ratePerSecond = (aprBps_ * 1e18) / (10_000 * 365 days);
    }

    function borrowRatePerSecond(
        uint256,
        uint256
    ) external view returns (uint256) {
        return ratePerSecond;
    }
}
