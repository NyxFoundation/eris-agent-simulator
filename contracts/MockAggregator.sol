// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAggregator
/// @notice Mock of the Chainlink-compatible aggregator that Aave V3's AaveOracle calls.
///         AaveOracle.getAssetPrice simply calls source.latestAnswer(), so this is a
///         "controllable oracle" that lets setAnswer inject any USD price (8 decimals).
contract MockAggregator {
    int256 private _answer;
    uint8 public constant decimals = 8;
    uint80 private _roundId;
    uint256 private _updatedAt;

    event AnswerUpdated(int256 indexed answer, uint256 updatedAt);

    constructor(int256 initialAnswer) {
        _set(initialAnswer);
    }

    /// @notice Set the price (USD, 8 decimals. e.g. $3000 -> 3000_00000000).
    function setAnswer(int256 answer) external {
        _set(answer);
    }

    function _set(int256 answer) internal {
        _answer = answer;
        _roundId += 1;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(answer, block.timestamp);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestTimestamp() external view returns (uint256) {
        return _updatedAt;
    }

    function latestRound() external view returns (uint256) {
        return _roundId;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
