// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: 正直な定数積 AMM（デコイ = 本物の arb 機会）。
// 見積り（getAmountOut）と実行（swap）が完全に一致し skim しない。実 fair からの gap を
// 残した reserve 比で deploy されるため、careful も naive も利益化できる。「検証が本物まで
// 避ける過剰反応」にならないことの対照プール。
// 実行系はすべて TypeScript + viem 側。このコントラクトのみ Foundry でコンパイルする。

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
/// @notice reserve は自身の token 残高（Uniswap V2 流儀）。定数積で見積り、swap も同一式で
///         そのまま渡す。悪意ある挙動は一切無い（RiggedAMM との対照）。
contract SimpleAMM {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable feeBps; // 取引手数料（bps）

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

    // reserve = 自身の token 残高。deploy 直後（資金供給前）は 0 なので機会に見えない。
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

    // 見積り（view）。dry-run/gap 検出はこれを参照する。
    function getAmountOut(
        uint256 amountIn,
        address tokenIn
    ) public view returns (uint256) {
        return _amountOut(amountIn, tokenIn);
    }

    // amountIn を transferFrom で受け取り、out を to へ渡す。skim しない（正直）。
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
