// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {AgentERC20} from "./AgentERC20.sol";

interface ILauncherUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
}

interface ILauncherUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
}

interface ILauncherERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address holder) external view returns (uint256);
}

interface ILauncherPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

/// @title TokenLauncher
/// @notice The environment's token listing (issue #29), in one transaction.
///
///         The listing used to be five transactions from the launch wallet: deploy the token with
///         CREATE, approve both sides, create-and-initialize the pool at 1.00 USDC, mint the full
///         range with zero minimums. The launch wallets are public from block 0 and their nonce does
///         not move until the window, so the token's address was known in advance -- and the Uniswap
///         factory does not check that a token has code. Anyone could create and initialize the pool
///         for the future token at a price of their choosing first; the environment's
///         `createAndInitializePoolIfNecessary` then skipped the initialize and its mint went in at
///         that price. Measured: the mint deposited the whole supply against 0.000001 USDC, and the
///         attacker bought it all for 1 USDC and sold it to the wave.
///
///         Here the token is deployed with CREATE2 under a salt only the environment knows, and the
///         pool is created and initialized in the same transaction, after checking that nobody
///         created it first. There is no state between the deploy and the mint for anyone to stand in.
///
///         Only the launch wallets fixed at construction can call it; the USDC is pulled from the
///         caller, the position NFT and any rounding dust go back to the caller, so the listing
///         reads on chain exactly as before: the launch wallet created the pool and holds the LP.
contract TokenLauncher {
    // The mint is into a pool this transaction just initialized, so its fill is determined; the
    // minimum is a statement of that, not a slippage allowance.
    uint256 public constant MIN_FILL_BPS = 9_900;

    address public immutable factory;
    address public immutable positionManager;
    address public immutable usdc;
    uint24 public immutable fee;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    mapping(address => bool) public isCaller;

    event Launched(
        address indexed caller,
        address indexed token,
        address indexed pool,
        uint256 tokenId,
        uint256 tokenSupply,
        uint256 usdcDeposited,
        uint256 tokenDeposited,
        uint128 liquidity
    );

    error NotCaller();
    error UnexpectedToken(address deployed, address expected);
    error PoolAlreadyExists(address pool);

    constructor(
        address factory_,
        address positionManager_,
        address usdc_,
        uint24 fee_,
        int24 tickLower_,
        int24 tickUpper_,
        address[] memory callers
    ) {
        factory = factory_;
        positionManager = positionManager_;
        usdc = usdc_;
        fee = fee_;
        tickLower = tickLower_;
        tickUpper = tickUpper_;
        for (uint256 i = 0; i < callers.length; i++) isCaller[callers[i]] = true;
    }

    struct LaunchParams {
        bytes32 salt;
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply;
        uint256 usdcAmount;
        // The CREATE2 address the caller computed; the price below is for that address's side.
        address expectedToken;
        uint160 sqrtPriceX96;
    }

    struct Minted {
        uint256 tokenId;
        uint128 liquidity;
        uint256 usdcUsed;
        uint256 tokenUsed;
    }

    function launch(LaunchParams calldata p)
        external
        returns (address token, address pool, uint256 tokenId)
    {
        if (!isCaller[msg.sender]) revert NotCaller();
        token = address(new AgentERC20{salt: p.salt}(p.name, p.symbol, p.decimals, p.supply));
        if (token != p.expectedToken) revert UnexpectedToken(token, p.expectedToken);
        address existing = ILauncherUniswapV3Factory(factory).getPool(token, usdc, fee);
        if (existing != address(0)) revert PoolAlreadyExists(existing);
        pool = ILauncherUniswapV3Factory(factory).createPool(token, usdc, fee);
        ILauncherUniswapV3Pool(pool).initialize(p.sqrtPriceX96);

        ILauncherERC20(usdc).transferFrom(msg.sender, address(this), p.usdcAmount);
        Minted memory m = _mint(token, p.supply, p.usdcAmount);
        tokenId = m.tokenId;
        _refund(token);
        emit Launched(
            msg.sender, token, pool, m.tokenId, p.supply, m.usdcUsed, m.tokenUsed, m.liquidity
        );
    }

    function _mint(address token, uint256 supply, uint256 usdcAmount)
        internal
        returns (Minted memory m)
    {
        ILauncherERC20(token).approve(positionManager, supply);
        ILauncherERC20(usdc).approve(positionManager, usdcAmount);
        bool tokenIs0 = token < usdc;
        uint256 amount0 = tokenIs0 ? supply : usdcAmount;
        uint256 amount1 = tokenIs0 ? usdcAmount : supply;
        (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1) = ILauncherPositionManager(
            positionManager
        ).mint(
            ILauncherPositionManager.MintParams({
                token0: tokenIs0 ? token : usdc,
                token1: tokenIs0 ? usdc : token,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: (amount0 * MIN_FILL_BPS) / 10_000,
                amount1Min: (amount1 * MIN_FILL_BPS) / 10_000,
                recipient: msg.sender,
                deadline: block.timestamp
            })
        );
        m.tokenId = tokenId;
        m.liquidity = liquidity;
        m.usdcUsed = tokenIs0 ? used1 : used0;
        m.tokenUsed = tokenIs0 ? used0 : used1;
    }

    // Rounding dust back to the launch wallet, and no allowance left standing.
    function _refund(address token) internal {
        ILauncherERC20(token).approve(positionManager, 0);
        ILauncherERC20(usdc).approve(positionManager, 0);
        uint256 tokenLeft = ILauncherERC20(token).balanceOf(address(this));
        if (tokenLeft > 0) ILauncherERC20(token).transfer(msg.sender, tokenLeft);
        uint256 usdcLeft = ILauncherERC20(usdc).balanceOf(address(this));
        if (usdcLeft > 0) ILauncherERC20(usdc).transfer(msg.sender, usdcLeft);
    }
}
