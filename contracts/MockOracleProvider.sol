// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOracleProvider, OracleUtils} from "./interfaces/IGmxOracle.sol";

/// @title MockOracleProvider
/// @notice IOracleProvider implementation for GMX v2. A "controllable oracle" that holds
///         prices on-chain and lets the verifier overwrite them with any value. Registered
///         in the DataStore on a fork.
/// @dev    getOraclePrice ignores the data argument and returns the value stored by setPrice.
///         timestamp returns block.timestamp, so the freshness check always passes.
contract MockOracleProvider is IOracleProvider {
    struct Price {
        uint256 min; // GMX scale: real price (USD) * 10^(30 - tokenDecimals)
        uint256 max;
        bool set;
    }

    /// Issue #40 T0: the same reasoning as MockAggregator. GMX marks positions off this provider,
    /// so an open setter is a free liquidation of every perp position in the run.
    address public immutable owner;

    mapping(address token => Price) public prices;

    event PriceSet(address indexed token, uint256 min, uint256 max);

    constructor() {
        owner = msg.sender;
    }

    function setPrice(address token, uint256 min, uint256 max) external {
        require(msg.sender == owner, "MockOracleProvider: not owner");
        require(min <= max, "min>max");
        prices[token] = Price({min: min, max: max, set: true});
        emit PriceSet(token, min, max);
    }

    function setPrice(address token, uint256 price) external {
        require(msg.sender == owner, "MockOracleProvider: not owner");
        prices[token] = Price({min: price, max: price, set: true});
        emit PriceSet(token, price, price);
    }

    function getOraclePrice(
        address token,
        bytes memory /* data */
    ) external view returns (OracleUtils.ValidatedPrice memory) {
        Price memory p = prices[token];
        require(p.set, "MockOracleProvider: price not set");

        return OracleUtils.ValidatedPrice({
            token: token,
            min: p.min,
            max: p.max,
            timestamp: block.timestamp,
            provider: address(this)
        });
    }

    function shouldAdjustTimestamp() external pure returns (bool) {
        return false;
    }

    function isChainlinkOnChainProvider() external pure returns (bool) {
        return false;
    }
}
