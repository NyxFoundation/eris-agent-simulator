// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IPriceFeedView {
    function latestAnswer() external view returns (int256);
    function answerOf(address token) external view returns (int256);
}

/// @title PriceFeedOracle
/// @notice The honest counterpart to `ConfigurableOracle`: an immutable, owner-less oracle that
///         reads the environment's `PriceFeed` (issue #40 T4). Nothing about it can be moved after
///         deployment, so a lending market pointed at one cannot be drained through its price.
///
///         It exists so that "the oracle has an owner" is a real discriminator rather than a
///         property every agent-created market shares. A verifier that refuses every market with a
///         movable oracle should still find markets to lend into.
///
/// @dev Returns the price of one whole collateral token denominated in the loan token, scaled by
///      1e36 and decimal-adjusted (the Morpho Blue convention `SimpleLending` reads). A token
///      address of `address(0)` means "treat as one dollar", which is how a stable leg is named:
///      the PriceFeed carries bases, not stables.
contract PriceFeedOracle {
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
    /// PriceFeed answers are 8-decimal USD fixed point, and `$1` is that scale's unit.
    uint256 internal constant USD_UNIT = 1e8;

    IPriceFeedView public immutable priceFeed;
    /// The base the feed keeps in slot 0 and serves through `latestAnswer()`; every other base goes
    /// through `answerOf`.
    address public immutable weth;
    address public immutable collateralFeedToken;
    address public immutable loanFeedToken;
    uint256 public immutable collateralUnit;
    uint256 public immutable loanUnit;

    error PriceUnavailable();

    constructor(
        address priceFeed_,
        address weth_,
        address collateralFeedToken_,
        address loanFeedToken_,
        uint8 collateralDecimals,
        uint8 loanDecimals
    ) {
        priceFeed = IPriceFeedView(priceFeed_);
        weth = weth_;
        collateralFeedToken = collateralFeedToken_;
        loanFeedToken = loanFeedToken_;
        collateralUnit = 10 ** collateralDecimals;
        loanUnit = 10 ** loanDecimals;
    }

    function price() external view returns (uint256) {
        uint256 collateralUsd = _usd(collateralFeedToken);
        uint256 loanUsd = _usd(loanFeedToken);
        if (collateralUsd == 0 || loanUsd == 0) revert PriceUnavailable();
        return (collateralUsd * loanUnit * ORACLE_PRICE_SCALE) / (loanUsd * collateralUnit);
    }

    function _usd(address token) internal view returns (uint256) {
        if (token == address(0)) return USD_UNIT;
        int256 answer = token == weth
            ? priceFeed.latestAnswer()
            : priceFeed.answerOf(token);
        return answer > 0 ? uint256(answer) : 0;
    }
}
