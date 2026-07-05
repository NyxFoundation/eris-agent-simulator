// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: honest constant-product AMM (the decoy = a genuine arb opportunity).
// The quote (getAmountOut) and the execution (swap) match exactly and never skim. Deployed with a
// reserve ratio that leaves a gap from the real fair price, so both careful and naive agents can
// profit. The counterpart pool that shows verification does not overreact into avoiding even the genuine ones.
// All execution logic lives on the TypeScript + viem side. Only this contract is compiled with Foundry.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SimpleAMM
/// @notice Reserves are the contract's own token balances (Uniswap V2 style). Quotes use the
///         constant product, and swap delivers with the same formula as-is. No malicious behavior
///         whatsoever (the counterpart to RiggedAMM).
contract SimpleAMM {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable feeBps; // trading fee (bps)

    event Swap(
        address indexed to,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address _token0, address _token1, uint24 _feeBps) {
        require(_feeBps < 10_000, "feeBps");
        token0 = _token0;
        token1 = _token1;
        feeBps = _feeBps;
    }

    // reserve = own token balance. Right after deploy (before funding) it is 0, so it doesn't look like an opportunity.
    function getReserves() public view returns (uint256 r0, uint256 r1) {
        r0 = IERC20(token0).balanceOf(address(this));
        r1 = IERC20(token1).balanceOf(address(this));
    }

    function _amountOut(
        uint256 amountIn,
        address tokenIn
    ) internal view returns (uint256) {
        (uint256 r0, uint256 r1) = getReserves();
        (uint256 rIn, uint256 rOut) = tokenIn == token0
            ? (r0, r1)
            : (r1, r0);
        if (rIn == 0 || rOut == 0) return 0;
        uint256 inAfterFee = (amountIn * (10_000 - feeBps)) / 10_000;
        return (rOut * inAfterFee) / (rIn + inAfterFee);
    }

    // Quote (view). dry-run/gap detection references this.
    function getAmountOut(
        uint256 amountIn,
        address tokenIn
    ) public view returns (uint256) {
        return _amountOut(amountIn, tokenIn);
    }

    // Receives amountIn via transferFrom and delivers out to `to`. Never skims (honest).
    function swap(
        uint256 amountIn,
        uint256 minOut,
        address tokenIn,
        address to
    ) external returns (uint256 out) {
        require(tokenIn == token0 || tokenIn == token1, "bad tokenIn");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        out = _amountOut(amountIn, tokenIn);
        require(out >= minOut, "slippage");
        require(
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "transferFrom"
        );
        require(IERC20(tokenOut).transfer(to, out), "transfer");
        emit Swap(to, tokenIn, amountIn, out);
    }
}
