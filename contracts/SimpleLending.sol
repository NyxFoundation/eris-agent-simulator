// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Price of one whole collateral token denominated in the loan token, scaled by 1e36 and
///         already adjusted for both tokens' decimals (the Morpho Blue oracle convention).
interface ILendingOracle {
    function price() external view returns (uint256);
}

/// @notice Borrow rate per second, in WAD (1e18 = 100%/second). Ornamental at this epoch length —
///         see the note on `_accrue` — but a real parameter a market creator picks.
interface ILendingIrm {
    function borrowRatePerSecond(
        uint256 totalSupplyAssets,
        uint256 totalBorrowAssets
    ) external view returns (uint256);
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

/// @title SimpleLending
/// @notice A permissionless lending singleton in the `SimpleAMM.sol` spirit (issue #40 T4). A market
///         is `(loanToken, collateralToken, oracle, irm, lltv)` and **anyone** calls `createMarket`.
///
///         Why not Aave: Aave's reserves are opened by `PoolConfigurator`, callable only by the
///         `POOL_ADMIN`, so Aave cannot be opened to agents without handing them admin. Aave stays
///         environment-only; this is the venue agents can create in. Canonical, environment-owned
///         code that a verifier can codehash-match is the point — vendoring a production protocol is
///         not.
///
///         **The oracle is any address, including one the creator controls.** That is the deliberate
///         fake-oracle surface (ADR 0014's deferred class, realized as an ordinary market
///         parameter): the verifier's job is to read the oracle address and ask who can move it. The
///         baits that work at a 12-minute epoch are the immediate ones — an apparently favourable
///         rate, leverage (high LLTV) and the liquidation incentive — so the trap's victim here is
///         the *borrower* or the *liquidator*, not the supplier.
///
///         The share/liquidation math follows Morpho Blue (virtual shares, `LIQUIDATION_CURSOR`,
///         bad-debt socialization onto the suppliers) because that last property is what makes
///         issue #40's third axiom implementable: a supply position marks at *recoverable* value, so
///         the oracle-drain attack shows up as a transfer instead of as fabricated value.
contract SimpleLending {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        // Aggregate collateral posted across every borrower. Not needed by any of the math below —
        // it exists so the scorer can mark a supply position at *recoverable* value without
        // enumerating borrowers (issue #40 axiom 3). What backs the outstanding debt is the whole
        // question when the collateral is a token the creator minted.
        uint128 totalCollateralAssets;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 internal constant LIQUIDATION_CURSOR = 0.3e18;
    uint256 internal constant MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15e18;
    /// Gas ceiling on the two calls into creator-chosen code. Neither can be trusted to terminate,
    /// and both run inside somebody else's transaction; the block-gas starvation this bounds is the
    /// same one issue #40 T0 puts a per-tx budget on.
    uint256 internal constant EXTERNAL_CALL_GAS = 200_000;
    /// ~1000%/yr. A market whose IRM asks for more is capped rather than reverted: the rate is the
    /// creator's parameter, but a market that cannot accrue is a market nobody can exit.
    uint256 internal constant MAX_BORROW_RATE_PER_SECOND = 317_097_919_837;

    mapping(bytes32 => Market) public market;
    mapping(bytes32 => mapping(address => Position)) public position;
    mapping(bytes32 => MarketParams) public marketParams;
    bytes32[] private _marketIds;

    uint256 private _locked;

    event CreateMarket(
        bytes32 indexed id,
        address indexed creator,
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    );
    event Supply(bytes32 indexed id, address indexed caller, uint256 assets, uint256 shares);
    event Withdraw(bytes32 indexed id, address indexed caller, uint256 assets, uint256 shares);
    event SupplyCollateral(bytes32 indexed id, address indexed caller, uint256 assets);
    event WithdrawCollateral(bytes32 indexed id, address indexed caller, uint256 assets);
    event Borrow(bytes32 indexed id, address indexed caller, uint256 assets, uint256 shares);
    event Repay(bytes32 indexed id, address indexed caller, uint256 assets, uint256 shares);
    event Liquidate(
        bytes32 indexed id,
        address indexed liquidator,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 seizedAssets,
        uint256 badDebtAssets
    );
    event AccrueInterest(bytes32 indexed id, uint256 interest);

    error AlreadyCreated();
    error MarketNotCreated();
    error InvalidLltv();
    error ZeroAmount();
    error InsufficientLiquidity();
    error InsufficientCollateral();
    error HealthyPosition();
    error OracleCallFailed();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        // Every market parameter is agent-chosen, so every token / oracle / IRM call is a call into
        // code the attacker wrote. Without this, a token with a transfer hook re-enters mid-state.
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    // ---------------------------------------------------------------------
    // market lifecycle
    // ---------------------------------------------------------------------

    function idOf(MarketParams memory params) public pure returns (bytes32) {
        return keccak256(abi.encode(params));
    }

    function createMarket(MarketParams memory params) external returns (bytes32 id) {
        // Only the one invariant the math needs. Everything else — a self-owned oracle, a 99% LLTV,
        // an IRM that lies — is a decision the creator is allowed to make and a counterparty is
        // supposed to read.
        if (params.lltv >= WAD) revert InvalidLltv();
        id = idOf(params);
        if (market[id].lastUpdate != 0) revert AlreadyCreated();
        market[id].lastUpdate = uint128(block.timestamp);
        marketParams[id] = params;
        _marketIds.push(id);
        emit CreateMarket(
            id,
            msg.sender,
            params.loanToken,
            params.collateralToken,
            params.oracle,
            params.irm,
            params.lltv
        );
    }

    function marketCount() external view returns (uint256) {
        return _marketIds.length;
    }

    function marketIdAt(uint256 index) external view returns (bytes32) {
        return _marketIds[index];
    }

    function marketIds() external view returns (bytes32[] memory) {
        return _marketIds;
    }

    // ---------------------------------------------------------------------
    // supply side
    // ---------------------------------------------------------------------

    function supply(
        MarketParams memory params,
        uint256 assets
    ) external nonReentrant returns (uint256 shares) {
        bytes32 id = _accrue(params);
        if (assets == 0) revert ZeroAmount();
        Market storage m = market[id];
        shares = _toSharesDown(assets, m.totalSupplyAssets, m.totalSupplyShares);
        position[id][msg.sender].supplyShares += shares;
        m.totalSupplyShares += uint128(shares);
        m.totalSupplyAssets += uint128(assets);
        _pullToken(params.loanToken, msg.sender, assets);
        emit Supply(id, msg.sender, assets, shares);
    }

    function withdraw(
        MarketParams memory params,
        uint256 assets
    ) external nonReentrant returns (uint256 shares) {
        bytes32 id = _accrue(params);
        if (assets == 0) revert ZeroAmount();
        Market storage m = market[id];
        shares = _toSharesUp(assets, m.totalSupplyAssets, m.totalSupplyShares);
        position[id][msg.sender].supplyShares -= shares;
        m.totalSupplyShares -= uint128(shares);
        m.totalSupplyAssets -= uint128(assets);
        // Utilisation is the supplier's risk, not an accounting error: what has been borrowed is not
        // in the contract to hand back.
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        _pushToken(params.loanToken, msg.sender, assets);
        emit Withdraw(id, msg.sender, assets, shares);
    }

    /// @notice Withdraw the caller's entire supply position, in assets. Convenience for an exit at
    ///         the bell, where "what are my shares worth" is exactly the number the caller wants.
    function withdrawAll(
        MarketParams memory params
    ) external nonReentrant returns (uint256 assets) {
        bytes32 id = _accrue(params);
        Market storage m = market[id];
        uint256 shares = position[id][msg.sender].supplyShares;
        if (shares == 0) revert ZeroAmount();
        assets = _toAssetsDown(shares, m.totalSupplyAssets, m.totalSupplyShares);
        position[id][msg.sender].supplyShares = 0;
        m.totalSupplyShares -= uint128(shares);
        m.totalSupplyAssets -= uint128(assets);
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        _pushToken(params.loanToken, msg.sender, assets);
        emit Withdraw(id, msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------------
    // borrow side
    // ---------------------------------------------------------------------

    function supplyCollateral(
        MarketParams memory params,
        uint256 assets
    ) external nonReentrant {
        bytes32 id = idOf(params);
        if (market[id].lastUpdate == 0) revert MarketNotCreated();
        if (assets == 0) revert ZeroAmount();
        position[id][msg.sender].collateral += uint128(assets);
        market[id].totalCollateralAssets += uint128(assets);
        _pullToken(params.collateralToken, msg.sender, assets);
        emit SupplyCollateral(id, msg.sender, assets);
    }

    function withdrawCollateral(
        MarketParams memory params,
        uint256 assets
    ) external nonReentrant {
        bytes32 id = _accrue(params);
        if (assets == 0) revert ZeroAmount();
        position[id][msg.sender].collateral -= uint128(assets);
        market[id].totalCollateralAssets -= uint128(assets);
        if (!_isHealthy(id, params, msg.sender)) revert InsufficientCollateral();
        _pushToken(params.collateralToken, msg.sender, assets);
        emit WithdrawCollateral(id, msg.sender, assets);
    }

    function borrow(
        MarketParams memory params,
        uint256 assets
    ) external nonReentrant returns (uint256 shares) {
        bytes32 id = _accrue(params);
        if (assets == 0) revert ZeroAmount();
        Market storage m = market[id];
        shares = _toSharesUp(assets, m.totalBorrowAssets, m.totalBorrowShares);
        position[id][msg.sender].borrowShares += uint128(shares);
        m.totalBorrowShares += uint128(shares);
        m.totalBorrowAssets += uint128(assets);
        if (!_isHealthy(id, params, msg.sender)) revert InsufficientCollateral();
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        _pushToken(params.loanToken, msg.sender, assets);
        emit Borrow(id, msg.sender, assets, shares);
    }

    function repay(
        MarketParams memory params,
        uint256 assets
    ) external nonReentrant returns (uint256 shares) {
        bytes32 id = _accrue(params);
        if (assets == 0) revert ZeroAmount();
        Market storage m = market[id];
        shares = _toSharesDown(assets, m.totalBorrowAssets, m.totalBorrowShares);
        position[id][msg.sender].borrowShares -= uint128(shares);
        m.totalBorrowShares -= uint128(shares);
        m.totalBorrowAssets = m.totalBorrowAssets > uint128(assets)
            ? m.totalBorrowAssets - uint128(assets)
            : 0;
        _pullToken(params.loanToken, msg.sender, assets);
        emit Repay(id, msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------------
    // liquidation
    // ---------------------------------------------------------------------

    /// @notice Seize `seizedAssets` of a borrower's collateral, repaying the corresponding debt plus
    ///         the incentive. The incentive is what baits a liquidator into a market whose oracle
    ///         someone else controls: the seizure is priced by that oracle too.
    function liquidate(
        MarketParams memory params,
        address borrower,
        uint256 seizedAssets
    ) external nonReentrant returns (uint256 repaidAssets) {
        bytes32 id = _accrue(params);
        if (seizedAssets == 0) revert ZeroAmount();
        if (_isHealthy(id, params, borrower)) revert HealthyPosition();

        uint256 collateralPrice = _price(params.oracle);
        uint256 lif = _liquidationIncentiveFactor(params.lltv);
        repaidAssets = _mulDivUp(
            _mulDivDown(seizedAssets, collateralPrice, ORACLE_PRICE_SCALE),
            WAD,
            lif
        );

        Market storage m = market[id];
        Position storage p = position[id][borrower];
        uint256 repaidShares = _toSharesDown(repaidAssets, m.totalBorrowAssets, m.totalBorrowShares);

        p.borrowShares -= uint128(repaidShares);
        m.totalBorrowShares -= uint128(repaidShares);
        m.totalBorrowAssets = m.totalBorrowAssets > uint128(repaidAssets)
            ? m.totalBorrowAssets - uint128(repaidAssets)
            : 0;
        p.collateral -= uint128(seizedAssets);
        m.totalCollateralAssets -= uint128(seizedAssets);

        // Bad debt: the collateral is gone and debt remains. Realizing it here — onto the suppliers,
        // in proportion — is what makes issue #40's axiom 3 true. Leaving it on the books would mark
        // every supplier at par against assets that no longer exist, and the oracle-drain attack
        // would read as value created rather than value transferred.
        uint256 badDebtAssets;
        if (p.collateral == 0 && p.borrowShares > 0) {
            badDebtAssets = _toAssetsUp(p.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
            if (badDebtAssets > m.totalSupplyAssets) badDebtAssets = m.totalSupplyAssets;
            m.totalBorrowShares -= p.borrowShares;
            m.totalBorrowAssets = m.totalBorrowAssets > uint128(badDebtAssets)
                ? m.totalBorrowAssets - uint128(badDebtAssets)
                : 0;
            m.totalSupplyAssets -= uint128(badDebtAssets);
            p.borrowShares = 0;
        }

        _pushToken(params.collateralToken, msg.sender, seizedAssets);
        _pullToken(params.loanToken, msg.sender, repaidAssets);
        emit Liquidate(id, msg.sender, borrower, repaidAssets, seizedAssets, badDebtAssets);
    }

    // ---------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------

    /// @notice What a supplier's shares are worth right now, and what a borrower owes. Both after a
    ///         read-only accrual, so a caller reading between two writes sees the same numbers the
    ///         next write would.
    function expectedPosition(
        MarketParams memory params,
        address user
    )
        external
        view
        returns (uint256 supplyAssets, uint256 borrowAssets, uint256 collateral)
    {
        bytes32 id = idOf(params);
        Market memory m = market[id];
        (uint256 supplyTotal, uint256 borrowTotal) = _accruedTotals(m, params);
        Position memory p = position[id][user];
        supplyAssets = _toAssetsDown(p.supplyShares, supplyTotal, m.totalSupplyShares);
        borrowAssets = _toAssetsUp(p.borrowShares, borrowTotal, m.totalBorrowShares);
        collateral = p.collateral;
    }

    function expectedMarket(
        MarketParams memory params
    ) external view returns (uint256 supplyAssets, uint256 borrowAssets) {
        Market memory m = market[idOf(params)];
        (supplyAssets, borrowAssets) = _accruedTotals(m, params);
    }

    function isHealthy(
        MarketParams memory params,
        address user
    ) external view returns (bool) {
        return _isHealthy(idOf(params), params, user);
    }

    function liquidationIncentiveFactor(uint256 lltv) external pure returns (uint256) {
        return _liquidationIncentiveFactor(lltv);
    }

    // ---------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------

    /// @dev Interest accrues in real time and is therefore decorative at this epoch length: an epoch
    ///      is 360 blocks x 2s = 12 minutes, and 3%/yr over 12 minutes is 0.00007%. The IRM ships
    ///      anyway, labelled honestly as ornamental (issue #40). Nothing here should be read as a
    ///      yield venue.
    function _accrue(MarketParams memory params) internal returns (bytes32 id) {
        id = idOf(params);
        Market storage m = market[id];
        if (m.lastUpdate == 0) revert MarketNotCreated();
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0) return id;
        m.lastUpdate = uint128(block.timestamp);
        if (m.totalBorrowAssets == 0) return id;
        uint256 rate = _borrowRate(params, m.totalSupplyAssets, m.totalBorrowAssets);
        if (rate == 0) return id;
        uint256 interest = _mulDivDown(m.totalBorrowAssets, rate * elapsed, WAD);
        if (interest == 0) return id;
        m.totalBorrowAssets += uint128(interest);
        m.totalSupplyAssets += uint128(interest);
        emit AccrueInterest(id, interest);
    }

    function _accruedTotals(
        Market memory m,
        MarketParams memory params
    ) internal view returns (uint256 supplyAssets, uint256 borrowAssets) {
        supplyAssets = m.totalSupplyAssets;
        borrowAssets = m.totalBorrowAssets;
        if (m.lastUpdate == 0 || borrowAssets == 0) return (supplyAssets, borrowAssets);
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0) return (supplyAssets, borrowAssets);
        uint256 rate = _borrowRate(params, supplyAssets, borrowAssets);
        if (rate == 0) return (supplyAssets, borrowAssets);
        uint256 interest = _mulDivDown(borrowAssets, rate * elapsed, WAD);
        supplyAssets += interest;
        borrowAssets += interest;
    }

    /// @dev A creator-chosen IRM that reverts, returns garbage or runs forever must not brick the
    ///      market: a market nobody can exit is a worse failure than one that stops accruing, and
    ///      under the round-trip rule "cannot get out" is exactly what the scoring punishes.
    function _borrowRate(
        MarketParams memory params,
        uint256 supplyAssets,
        uint256 borrowAssets
    ) internal view returns (uint256) {
        if (params.irm == address(0)) return 0;
        (bool ok, bytes memory data) = params.irm.staticcall{gas: EXTERNAL_CALL_GAS}(
            abi.encodeWithSelector(
                ILendingIrm.borrowRatePerSecond.selector,
                supplyAssets,
                borrowAssets
            )
        );
        if (!ok || data.length < 32) return 0;
        uint256 rate = abi.decode(data, (uint256));
        return rate > MAX_BORROW_RATE_PER_SECOND ? MAX_BORROW_RATE_PER_SECOND : rate;
    }

    /// @dev The oracle is the opposite case: an unreadable price must revert, never read as zero.
    ///      Zero would mark every borrower instantly liquidatable, turning a broken oracle into a
    ///      free seizure of everyone's collateral.
    function _price(address oracle) internal view returns (uint256) {
        (bool ok, bytes memory data) = oracle.staticcall{gas: EXTERNAL_CALL_GAS}(
            abi.encodeWithSelector(ILendingOracle.price.selector)
        );
        if (!ok || data.length < 32) revert OracleCallFailed();
        return abi.decode(data, (uint256));
    }

    function _isHealthy(
        bytes32 id,
        MarketParams memory params,
        address user
    ) internal view returns (bool) {
        Position memory p = position[id][user];
        if (p.borrowShares == 0) return true;
        Market memory m = market[id];
        (, uint256 borrowTotal) = _accruedTotals(m, params);
        uint256 borrowed = _toAssetsUp(p.borrowShares, borrowTotal, m.totalBorrowShares);
        uint256 collateralValue = _mulDivDown(p.collateral, _price(params.oracle), ORACLE_PRICE_SCALE);
        return borrowed <= _mulDivDown(collateralValue, params.lltv, WAD);
    }

    /// @dev Morpho's formula: the incentive falls out of the LLTV rather than being its own knob, so
    ///      a creator advertising "safe, low leverage" is also advertising the fat liquidation bonus
    ///      that makes their oracle worth checking.
    function _liquidationIncentiveFactor(uint256 lltv) internal pure returns (uint256) {
        uint256 factor = _mulDivDown(
            WAD,
            WAD,
            WAD - _mulDivDown(LIQUIDATION_CURSOR, WAD - lltv, WAD)
        );
        return factor > MAX_LIQUIDATION_INCENTIVE_FACTOR
            ? MAX_LIQUIDATION_INCENTIVE_FACTOR
            : factor;
    }

    function _toSharesDown(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) internal pure returns (uint256) {
        return _mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function _toSharesUp(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) internal pure returns (uint256) {
        return _mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function _toAssetsDown(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) internal pure returns (uint256) {
        return _mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    function _toAssetsUp(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) internal pure returns (uint256) {
        return _mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    function _mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b + (d - 1)) / d;
    }

    /// @dev Both tokens are agent-chosen and may be non-standard (a honeypot that returns false, or
    ///      returns nothing at all). Accept the no-return form, reject the explicit false.
    function _pullToken(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _pushToken(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
