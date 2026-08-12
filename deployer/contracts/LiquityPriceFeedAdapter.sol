// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IErisPriceFeed {
    function latestAnswer() external view returns (int256);
}

/// @title LiquityPriceFeedAdapter
/// @notice Liquity's `IPriceFeed`, served from the environment's own PriceFeed (ADR 0006 §3).
///
///         Two constraints meet here. Liquity renounces ownership once its contracts are wired, so
///         the oracle address baked into TroveManager and BorrowerOperations is permanent. The
///         environment, meanwhile, deploys a fresh PriceFeed at the start of every run. This sits
///         between them: Liquity holds this address forever, and each run points it at whatever
///         PriceFeed it just deployed.
///
///         Shipping Liquity's own `PriceFeedTestnet` instead was not an option -- its `setPrice` is
///         unpermissioned, so any agent could set the oracle it is being liquidated against.
///
///         Repointing is gated on the simulation's admin key rather than the deployer's, the same
///         way the LST vault takes an operator (issue #38), so a run can rewire the venue without
///         holding the key that deployed it.
contract LiquityPriceFeedAdapter {
    /// The simulation's admin account (`keccak256("eris-role:admin")`), fixed at deploy time.
    address public immutable operator;

    /// The run's PriceFeed. Zero until a run points it somewhere.
    address public source;

    /// Last price actually served, in Liquity's 1e18 scale.
    uint256 public lastGoodPrice;

    event LastGoodPriceUpdated(uint256 _lastGoodPrice);
    event SourceUpdated(address indexed source);

    constructor(address _operator, uint256 _initialPrice) {
        require(_operator != address(0), "LiquityPriceFeed: no operator");
        require(_initialPrice > 0, "LiquityPriceFeed: no initial price");
        operator = _operator;
        lastGoodPrice = _initialPrice;
    }

    function setSource(address _source) external {
        require(msg.sender == operator, "LiquityPriceFeed: not operator");
        source = _source;
        emit SourceUpdated(_source);
    }

    /// @notice Liquity calls this on every state-changing path -- opening, adjusting, liquidating,
    ///         redeeming. It must not revert: a revert here would freeze the whole venue, including
    ///         the liquidations that a falling price is supposed to trigger. An unset or unreadable
    ///         source therefore keeps serving the last price it did serve, which is also how
    ///         Liquity's own PriceFeed behaves when Chainlink breaks.
    function fetchPrice() external returns (uint256) {
        uint256 p = _read();
        if (p != 0) {
            lastGoodPrice = p;
            emit LastGoodPriceUpdated(p);
        }
        return lastGoodPrice;
    }

    function _read() internal view returns (uint256) {
        if (source == address(0)) return 0;
        try IErisPriceFeed(source).latestAnswer() returns (int256 answer) {
            if (answer <= 0) return 0;
            // The environment's feed is 8-decimal fixed point (USDC per WETH); Liquity works in 1e18.
            return uint256(answer) * 1e10;
        } catch {
            return 0;
        }
    }
}
