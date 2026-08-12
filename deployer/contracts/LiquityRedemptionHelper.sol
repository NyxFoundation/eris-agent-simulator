// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPriceFeed {
    function fetchPrice() external returns (uint256);
}

interface IHintHelpers {
    function getRedemptionHints(uint256 amount, uint256 price, uint256 maxIterations)
        external
        view
        returns (address firstRedemptionHint, uint256 partialRedemptionHintNICR, uint256 truncatedAmount);
}

interface ISortedTroves {
    function findInsertPosition(uint256 nicr, address prevId, address nextId)
        external
        view
        returns (address, address);
}

interface ITroveManager {
    function redeemCollateral(
        uint256 amount,
        address firstRedemptionHint,
        address upperPartialRedemptionHint,
        address lowerPartialRedemptionHint,
        uint256 partialRedemptionHintNICR,
        uint256 maxIterations,
        uint256 maxFeePercentage
    ) external;
}

/// @title LiquityRedemptionHelper
/// @notice Computes a redemption's hints in the same transaction that uses them (issue #39).
///
///         Liquity's partial redemption is checked against a hint the caller supplies:
///         `_redeemCollateralFromTrove` recomputes the last Trove's nominal ICR from the price the
///         redemption fetched and cancels the partial unless it matches `partialRedemptionHintNICR`
///         exactly. The hint therefore depends on the oracle price at *execution*, and this
///         environment writes a new price every block (ADR 0006 §3) — always ahead of an agent's
///         transaction, since the oracle write bids the top of the block. Hints computed off-chain
///         are stale by construction, and a redemption built from them reverts with
///         "TroveManager: Unable to redeem any amount". Measured, not assumed: every redemption in
///         the first live run of the venue failed that way.
///
///         So the hints are computed here instead, after `fetchPrice()` has already cached the
///         price this transaction will redeem at. Nothing about Liquity changes — this is periphery
///         in exactly the sense HintHelpers is, and it holds no funds between transactions.
contract LiquityRedemptionHelper {
    ITroveManager public immutable troveManager;
    IHintHelpers public immutable hintHelpers;
    ISortedTroves public immutable sortedTroves;
    IPriceFeed public immutable priceFeed;
    IERC20 public immutable eusd;

    /// The whole redemption call, resolved at execution. A struct rather than five locals because
    /// Liquity's redemption takes seven arguments and solc 0.8.20 runs out of stack otherwise.
    struct Plan {
        address firstHint;
        address upperHint;
        address lowerHint;
        uint256 partialNICR;
        uint256 truncated;
    }

    event Redeemed(address indexed redeemer, uint256 eusdIn, uint256 eusdRedeemed, uint256 ethOut);

    constructor(
        address _troveManager,
        address _hintHelpers,
        address _sortedTroves,
        address _priceFeed,
        address _eusd
    ) {
        troveManager = ITroveManager(_troveManager);
        hintHelpers = IHintHelpers(_hintHelpers);
        sortedTroves = ISortedTroves(_sortedTroves);
        priceFeed = IPriceFeed(_priceFeed);
        eusd = IERC20(_eusd);
    }

    /// @notice Redeem eUSD for collateral, hinted at the price this transaction will use.
    /// @param amount eUSD to redeem. The sorted list may absorb less (a Trove that would be left
    ///        under MIN_NET_DEBT is skipped), in which case the remainder is returned unspent.
    /// @param maxFeePercentage slippage bound on the redemption fee, in 1e18 scale.
    /// @param maxIterations cap on how many Troves the redemption walks (0 = no cap).
    function redeem(uint256 amount, uint256 maxFeePercentage, uint256 maxIterations)
        external
        returns (uint256 redeemed, uint256 ethOut)
    {
        require(amount > 0, "RedemptionHelper: zero amount");
        require(eusd.transferFrom(msg.sender, address(this), amount), "RedemptionHelper: transfer in failed");

        Plan memory plan = _plan(amount, maxIterations);
        ethOut = address(this).balance;
        troveManager.redeemCollateral(
            plan.truncated,
            plan.firstHint,
            plan.upperHint,
            plan.lowerHint,
            plan.partialNICR,
            maxIterations,
            maxFeePercentage
        );
        ethOut = address(this).balance - ethOut;
        redeemed = plan.truncated;

        // Whatever the list could not absorb goes straight back: an agent that asked to redeem more
        // than the system could take should be short the difference in eUSD, not in trust.
        uint256 leftover = eusd.balanceOf(address(this));
        if (leftover > 0) {
            require(eusd.transfer(msg.sender, leftover), "RedemptionHelper: refund failed");
        }
        if (ethOut > 0) {
            (bool ok,) = msg.sender.call{value: ethOut}("");
            require(ok, "RedemptionHelper: eth payout failed");
        }
        emit Redeemed(msg.sender, amount, redeemed, ethOut);
    }

    /// Resolve the redemption against the price this transaction will use.
    ///
    /// `fetchPrice` is what caches it: Liquity's own `redeemCollateral` calls the same function, and
    /// within one transaction it returns the same number, so the hint below and the redemption that
    /// checks it cannot disagree.
    function _plan(uint256 amount, uint256 maxIterations) internal returns (Plan memory plan) {
        uint256 price = priceFeed.fetchPrice();
        (plan.firstHint, plan.partialNICR, plan.truncated) =
            hintHelpers.getRedemptionHints(amount, price, maxIterations);
        require(plan.truncated > 0, "RedemptionHelper: nothing redeemable");
        (plan.upperHint, plan.lowerHint) =
            sortedTroves.findInsertPosition(plan.partialNICR, address(0), address(0));
    }

    receive() external payable {}
}
