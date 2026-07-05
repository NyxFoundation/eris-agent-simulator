// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// FlashArb (GitHub #3): receiver for Aave V3 flashLoanSimple.
// Executes a cross-venue arbitrage ("buy WETH on the cheap venue -> sell WETH on the
// expensive venue") in a single tx using the borrowed USDC, repays amount+premium, and
// sends the remainder (profit) to the initiator (= the agent that triggered it).
// Targets the pool <-> frozen-venue divergence at a size beyond the self-funded cap
// (the flash version of #4).
//
// All execution logic lives on the TypeScript + viem side. Only this contract is compiled with Foundry.

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IBalancerVault {
    enum SwapKind {
        GIVEN_IN,
        GIVEN_OUT
    }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address recipient;
        bool toInternalBalance;
    }

    function swap(
        SingleSwap calldata singleSwap,
        FundManagement calldata funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256);
}

contract FlashArb {
    address public immutable pool; // Aave V3 Pool
    address public immutable router; // Uniswap V3 SwapRouter
    address public immutable vault; // Balancer Vault
    bytes32 public immutable balancerPoolId;
    address public immutable weth;
    address public immutable usdc;
    uint24 public immutable uniFee;

    constructor(
        address _pool,
        address _router,
        address _vault,
        bytes32 _balancerPoolId,
        address _weth,
        address _usdc,
        uint24 _uniFee
    ) {
        pool = _pool;
        router = _router;
        vault = _vault;
        balancerPoolId = _balancerPoolId;
        weth = _weth;
        usdc = _usdc;
        uniFee = _uniFee;
    }

    // mode 0: buy USDC->WETH on Uniswap -> sell WETH->USDC on Balancer
    // mode 1: buy USDC->WETH on Balancer -> sell WETH->USDC on Uniswap
    struct Params {
        uint8 mode;
        uint256 wethMinOut; // minimum WETH received on the buy leg
        uint256 usdcMinOut; // minimum USDC received on the sell leg
        address profitTo; // profit recipient (the agent that triggered it)
    }

    // The agent calls Pool.flashLoanSimple(receiver=this, asset=USDC, amount, params).
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address, /* initiator */
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == pool, "caller must be Pool");
        Params memory p = abi.decode(params, (Params));

        uint256 wethOut;
        if (p.mode == 0) {
            wethOut = _uniSwap(usdc, weth, amount, p.wethMinOut);
            _balSwap(weth, usdc, wethOut, p.usdcMinOut);
        } else {
            wethOut = _balSwap(usdc, weth, amount, p.wethMinOut);
            _uniSwap(weth, usdc, wethOut, p.usdcMinOut);
        }

        uint256 owed = amount + premium;
        IERC20(asset).approve(pool, owed); // Pool collects via transferFrom
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal > owed && p.profitTo != address(0)) {
            IERC20(asset).transfer(p.profitTo, bal - owed);
        }
        return true;
    }

    function _uniSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(router, amountIn);
        return
            ISwapRouter(router).exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: uniFee,
                    recipient: address(this),
                    deadline: block.timestamp + 600,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
    }

    function _balSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(vault, amountIn);
        return
            IBalancerVault(vault).swap(
                IBalancerVault.SingleSwap({
                    poolId: balancerPoolId,
                    kind: IBalancerVault.SwapKind.GIVEN_IN,
                    assetIn: tokenIn,
                    assetOut: tokenOut,
                    amount: amountIn,
                    userData: ""
                }),
                IBalancerVault.FundManagement({
                    sender: address(this),
                    fromInternalBalance: false,
                    recipient: address(this),
                    toInternalBalance: false
                }),
                minOut,
                block.timestamp + 600
            );
    }
}
