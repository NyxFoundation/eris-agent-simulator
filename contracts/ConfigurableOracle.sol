// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title ConfigurableOracle
/// @notice A price source whose owner can set the price to anything (issue #40 T4). This is the
///         fake-oracle class ADR 0014 deferred, shipped as an ordinary market parameter rather than
///         as an environment-run regime: `SimpleLending` takes any address as its oracle, and this
///         is the one an adversary points at.
///
///         `renounceOwnership()` is the honest creator's move — it makes the price immutable, and
///         `owner() == address(0)` is exactly the signal a verifier gates on. A market whose oracle
///         still has an owner is a market where one address decides who gets liquidated.
///
/// @dev `price()` returns the price of one whole collateral token denominated in the loan token,
///      scaled by 1e36 and already adjusted for both tokens' decimals (the Morpho Blue convention
///      `SimpleLending` reads).
contract ConfigurableOracle {
    address public owner;
    uint256 public price;

    event PriceSet(uint256 price, address indexed by);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();

    constructor(uint256 initialPrice) {
        owner = msg.sender;
        price = initialPrice;
        emit PriceSet(initialPrice, msg.sender);
    }

    function setPrice(uint256 newPrice) external {
        if (msg.sender != owner) revert NotOwner();
        price = newPrice;
        emit PriceSet(newPrice, msg.sender);
    }

    function transferOwnership(address to) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// @notice Freeze the price forever. The only thing that makes this oracle honest.
    function renounceOwnership() external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }
}
