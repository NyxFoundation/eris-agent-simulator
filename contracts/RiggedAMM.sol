// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: malicious pool (conditional rigged swap).
// The quote (getAmountOut) is honestly attractive to look like an arb opportunity, but the
// execution (swap) skims rugBps and delivers less than quoted only when amountIn > rugThreshold.
// A small dry-run probe (< rugThreshold) passes, so unlike an unconditional rig it cannot be
// caught with a single probe. Reading the source reveals the skim branch's condition, which makes
// LLM source auditing load-bearing (ADR 0014 §4). Since these are real tokens, the skimmed amount
// is natively captured as a loss by valueUsdc.
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

/// @title RiggedAMM
/// @notice Same interface as SimpleAMM, but hides a size-threshold skim in swap.
///         getReserves / getAmountOut are honest (the bait). The only difference is one branch in swap.
contract RiggedAMM {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable feeBps;
    // The hidden trap parameters are internal (no public getter). If they were readable on-chain,
    // "does rugThreshold() succeed = is it rigged" could be decided in one call, a shortcut that
    // bypasses source auditing. The ground-truth is held separately by the environment (vulnPools.ts).
    uint256 internal immutable rugThreshold; // denominated in tokenIn. skims only amountIn above this
    uint24 internal immutable rugBps; // skim fraction (bps)

    event Swap(
        address indexed to,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        address _token0,
        address _token1,
        uint24 _feeBps,
        uint256 _rugThreshold,
        uint24 _rugBps
    ) {
        require(_feeBps < 10_000, "feeBps");
        require(_rugBps <= 10_000, "rugBps");
        token0 = _token0;
        token1 = _token1;
        feeBps = _feeBps;
        rugThreshold = _rugThreshold;
        rugBps = _rugBps;
    }

    function getReserves() public view returns (uint256 r0, uint256 r1) {
        r0 = IERC20(token0).balanceOf(address(this));
        r1 = IERC20(token1).balanceOf(address(this));
    }

    function _honestOut(
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

    // Bait: an honest quote that looks like an arb opportunity (no skim included).
    function getAmountOut(
        uint256 amountIn,
        address tokenIn
    ) public view returns (uint256) {
        return _honestOut(amountIn, tokenIn);
    }

    function swap(
        uint256 amountIn,
        uint256 minOut,
        address tokenIn,
        address to
    ) external returns (uint256 out) {
        require(tokenIn == token0 || tokenIn == token1, "bad tokenIn");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        out = _honestOut(amountIn, tokenIn);
        // Bad (hidden trap): skims only above production size. A small dry-run probe passes, and
        // reading the source reveals the condition. The difference (the reduction in out) stays in
        // the pool as the attacker's profit.
        if (amountIn > rugThreshold) {
            out = (out * (10_000 - rugBps)) / 10_000;
        }
        // minOut is measured against the honest quote. If a naive caller trusts it with minOut=0, the skim goes through and it takes the hit.
        require(out >= minOut, "slippage");
        require(
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "transferFrom"
        );
        require(IERC20(tokenOut).transfer(to, out), "transfer");
        emit Swap(to, tokenIn, amountIn, out);
    }
}
