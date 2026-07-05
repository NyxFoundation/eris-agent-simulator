// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal local definitions of the GMX v2 (gmx-synthetics) oracle-related types.
// The struct field order and types, and the function selectors, must match the production contracts.
// Reference: vendor/gmx-src/contracts/oracle/OracleUtils.sol, IOracleProvider.sol

library OracleUtils {
    // A validated price the Oracle receives from a provider.
    // Field order and types must match vendor exactly.
    struct ValidatedPrice {
        address token;
        uint256 min;
        uint256 max;
        uint256 timestamp;
        address provider;
    }
}

// The provider interface the GMX v2 Oracle calls to fetch token prices.
interface IOracleProvider {
    function getOraclePrice(address token, bytes memory data) external returns (OracleUtils.ValidatedPrice memory);

    // Returns false except for ChainlinkPriceFeedProvider (whether to adjust the timestamp).
    function shouldAdjustTimestamp() external pure returns (bool);

    // True only for ChainlinkPriceFeedProvider. When true, the reference-price deviation check is skipped.
    function isChainlinkOnChainProvider() external pure returns (bool);
}
