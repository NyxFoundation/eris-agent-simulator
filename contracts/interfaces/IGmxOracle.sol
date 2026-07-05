// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal local definitions of the oracle-related types for GMX v2 (gmx-synthetics).
// The struct field order/types and the function selectors must match the production contracts.
// Reference: gmx-io/gmx-synthetics contracts/oracle/OracleUtils.sol, IOracleProvider.sol

library OracleUtils {
    struct ValidatedPrice {
        address token;
        uint256 min;
        uint256 max;
        uint256 timestamp;
        address provider;
    }
}

interface IOracleProvider {
    function getOraclePrice(
        address token,
        bytes memory data
    ) external returns (OracleUtils.ValidatedPrice memory);

    function shouldAdjustTimestamp() external pure returns (bool);

    function isChainlinkOnChainProvider() external pure returns (bool);
}
