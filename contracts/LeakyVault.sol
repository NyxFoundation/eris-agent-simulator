// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title LeakyVault
/// @notice The **honest-but-buggy** contract the exploit-hunter hunts (issue #40 phase 4). It is the
///         counterpart to `RiggedAMM` / `HoneypotToken`: those are deliberately hostile, this is
///         meant to work and does — except for one function its author forgot to gate.
///
///         The deposit / withdraw path is correct: a supplier deposits the single token the vault
///         holds, gets shares 1:1, and withdraws them back. Nothing here skims, blocks, or lies. A
///         careful counterparty who reads only *this* logic finds nothing wrong, which is the point:
///         the bug is not in what the vault does, it is in what it forgot to forbid.
///
///         `rescue()` was intended as an owner-only escape hatch — the kind of function a real vault
///         ships so an operator can recover funds after an incident. **The `onlyOwner` guard is
///         missing.** Anyone can call it, and it sends the vault's entire balance to the caller. This
///         is the single most common way real vaults have been drained, and it is honest in the way
///         this environment means: the creator wanted a working vault, not a trap.
///
///         Under the round-trip rule the exploit is a transfer, not fabricated value. A supplier who
///         deposits and cannot withdraw before the epoch's final block is already scored at zero on
///         that holding (value inside an unknown contract). When a hunter drains it, the hunter's
///         wallet gains exactly what the supplier could no longer recover. The books close.
contract LeakyVault {
    address public immutable owner;
    address public immutable token;
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    event Deposit(address indexed who, uint256 assets, uint256 shares);
    event Withdraw(address indexed who, uint256 assets, uint256 shares);
    event Rescued(address indexed to, uint256 amount);

    error ZeroAmount();
    error InsufficientShares();
    error TransferFailed();

    constructor(address token_) {
        owner = msg.sender;
        token = token_;
    }

    /// @notice Deposit `assets` of the vault's token and receive shares. Correct: shares track the
    ///         pool pro rata, and the first depositor sets the rate 1:1.
    function deposit(uint256 assets) external returns (uint256 minted) {
        if (assets == 0) revert ZeroAmount();
        uint256 bal = IERC20(token).balanceOf(address(this));
        minted = totalShares == 0 || bal == 0
            ? assets
            : (assets * totalShares) / bal;
        if (minted == 0) revert ZeroAmount();
        shares[msg.sender] += minted;
        totalShares += minted;
        _pull(msg.sender, assets);
        emit Deposit(msg.sender, assets, minted);
    }

    /// @notice Burn `sharesToBurn` and receive the corresponding assets. Correct.
    function withdraw(uint256 sharesToBurn) external returns (uint256 assets) {
        if (sharesToBurn == 0) revert ZeroAmount();
        uint256 owned = shares[msg.sender];
        if (sharesToBurn > owned) revert InsufficientShares();
        uint256 bal = IERC20(token).balanceOf(address(this));
        assets = (sharesToBurn * bal) / totalShares;
        shares[msg.sender] = owned - sharesToBurn;
        totalShares -= sharesToBurn;
        _push(msg.sender, assets);
        emit Withdraw(msg.sender, assets, sharesToBurn);
    }

    /// @notice Withdraw everything the caller holds. Convenience for an exit at the bell.
    function withdrawAll() external returns (uint256 assets) {
        uint256 owned = shares[msg.sender];
        if (owned == 0) revert ZeroAmount();
        uint256 bal = IERC20(token).balanceOf(address(this));
        assets = (owned * bal) / totalShares;
        shares[msg.sender] = 0;
        totalShares -= owned;
        _push(msg.sender, assets);
        emit Withdraw(msg.sender, assets, owned);
    }

    /// @notice Emergency recovery of the vault's balance.
    /// @dev    BUG: intended to be owner-only. The `require(msg.sender == owner)` was left out, so
    ///         anyone can call it and take the whole balance. This is the vulnerability the
    ///         exploit-hunter is built to find and drain (issue #40 phase 4). It is left visibly
    ///         un-gated on purpose: the interesting question is whether a hunter that only has the
    ///         *bytecode* — no ABI, no source — can discover it and get the value out in time.
    function rescue() external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        emit Rescued(msg.sender, bal);
        _push(msg.sender, bal);
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
