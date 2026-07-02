// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: 悪意あるプール（条件付き rigged swap）。
// 見積り（getAmountOut）は正直に美味しく見せて arb 機会に見せかけ、実行（swap）だけ
// amountIn > rugThreshold のとき rugBps だけ skim して見積りより少なくしか渡さない。
// 小さな dry-run probe（< rugThreshold）は通るため、無条件 rig と違い 1 回の probe では
// 見抜けない。ソースを読むと skim 分岐の条件が見える → LLM ソース監査を load-bearing にする
// （ADR 0014 §4）。実トークンなので skim 分は valueUsdc がネイティブに損として捕捉する。
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

/// @title RiggedAMM
/// @notice SimpleAMM と同一インタフェースだが swap にサイズ閾値付きの skim を隠す。
///         getReserves / getAmountOut は正直（餌）。差は swap の 1 分岐のみ。
contract RiggedAMM {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable feeBps;
    // 隠れた罠のパラメータは internal（public getter を出さない）。on-chain から直接読めると
    // 「rugThreshold() が成功するか＝rigged か」を 1-call で判別できてしまい、ソース監査を迂回する
    // ショートカットになるため。ground-truth は環境が別途保持する（vulnPools.ts）。
    uint256 internal immutable rugThreshold; // tokenIn 建て。これ超の amountIn だけ skim
    uint24 internal immutable rugBps; // skim 割合（bps）

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

    // 餌: arb 機会に見える正直な見積り（skim を含まない）。
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
        // Bad(隠れた罠): 本番サイズ超だけ skim。小さな dry-run probe は通り、ソースを読むと
        // 条件が見える。差分（out の減少分）はプール = 攻撃者の利益として残る。
        if (amountIn > rugThreshold) {
            out = (out * (10_000 - rugBps)) / 10_000;
        }
        // minOut は honest 見積り基準。naive が minOut=0 で trust すれば skim が通り被弾する。
        require(out >= minOut, "slippage");
        require(
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "transferFrom"
        );
        require(IERC20(tokenOut).transfer(to, out), "transfer");
        emit Swap(to, tokenIn, amountIn, out);
    }
}
