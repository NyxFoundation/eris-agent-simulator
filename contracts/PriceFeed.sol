// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PriceFeed
/// @notice Dedicated distribution contract where the environment (coordinator) writes the fair
///         price every block (ADR 0006 §3). After the observation stdin push was removed, agents
///         read this to learn the fair price. The setup — divergence from the uniswap pool price
///         is the arbitrage signal — is unchanged.
///         Only the owner (the environment's admin wallet) can write, preventing agent tampering.
///
///         ADR 0013 (multi-asset): the WETH price stays in _answer (slot 0) as before, preserving
///         the compatible latestAnswer/setPrice/updatedAtBlock API and storage slots. Additional
///         bases (WBTC, etc.) go in the _answers mapping (slot 2), read/written via setPriceFor/answerOf.
///         Slots 0/1 for the direct storage write (ADR 0011) are unchanged, so the economic-gas path needs no changes.
contract PriceFeed {
    address public immutable owner;
    int256 private _answer; // WETH. USDC per WETH (8-decimal fixed point. e.g. $3000 -> 3000_00000000). slot 0
    uint256 private _updatedAtBlock; // slot 1
    mapping(address => int256) private _answers; // ADR 0013: USD price of additional bases. slot 2
    mapping(address => uint256) private _answerUpdatedAtBlock; // slot 3

    uint8 public constant decimals = 8;

    event PriceUpdated(int256 answer, uint256 blockNumber);
    event PriceUpdatedFor(
        address indexed token,
        int256 answer,
        uint256 blockNumber
    );

    constructor(int256 initialAnswer) {
        owner = msg.sender;
        _answer = initialAnswer;
        _updatedAtBlock = block.number;
    }

    // ---- WETH (backward-compatible API. slot 0/1) ----
    function setPrice(int256 answer) external {
        require(msg.sender == owner, "PriceFeed: not owner");
        _answer = answer;
        _updatedAtBlock = block.number;
        emit PriceUpdated(answer, block.number);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function updatedAtBlock() external view returns (uint256) {
        return _updatedAtBlock;
    }

    // ---- additional bases (ADR 0013. slot 2 mapping) ----
    function setPriceFor(address token, int256 answer) external {
        require(msg.sender == owner, "PriceFeed: not owner");
        _answers[token] = answer;
        _answerUpdatedAtBlock[token] = block.number;
        emit PriceUpdatedFor(token, answer, block.number);
    }

    function answerOf(address token) external view returns (int256) {
        return _answers[token];
    }

    function answerUpdatedAtBlockOf(
        address token
    ) external view returns (uint256) {
        return _answerUpdatedAtBlock[token];
    }
}
