// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title HoneypotToken
/// @notice The can't-sell trap class (issue #40 T7, ADR 0014's deferred list). It buys like any
///         ERC-20 and refuses to sell: `transfer` from anyone other than the issuer into the pool
///         reverts once the issuer flips `sellsBlocked`.
///
///         Under the round-trip scoring rule this needs no special handling anywhere in the scorer.
///         Every trap class collapses into one failure mode — **you could not get out in time** — so
///         a holder of this at the epoch's final block is marked at zero for the same reason a
///         holder of a perfectly honest agent-issued token is. The difference is that the honest one
///         had a pool to exit through.
///
///         It is deliberately not disguised in this repository: it is the reference adversary the
///         verifier agents are tested against, and the interesting question is whether an agent
///         notices the *shape* (an owner who can change what transfer does) rather than the name.
contract HoneypotToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    address public owner;

    /// While true, only the owner may move tokens *to* a blocked address (in practice, the pool).
    bool public sellsBlocked;
    mapping(address => bool) public blocked;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event SellsBlockedSet(bool blocked);

    error NotOwner();
    error SellBlocked();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        owner = msg.sender;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function setSellsBlocked(bool value) external {
        if (msg.sender != owner) revert NotOwner();
        sellsBlocked = value;
        emit SellsBlockedSet(value);
    }

    function setBlocked(address target, bool value) external {
        if (msg.sender != owner) revert NotOwner();
        blocked[target] = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (sellsBlocked && blocked[to] && from != owner) revert SellBlocked();
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
