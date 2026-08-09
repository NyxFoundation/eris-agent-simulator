// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Minimal WETH/ERC20 surface the vault needs from its underlying asset.
interface IVaultAsset {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MockLSTVault
/// @notice A self-contained liquid-staking vault in the style of wstETH: a **non-rebasing** share
///         token whose redemption rate rises as staking yield accrues, plus a Lido-style
///         request -> finalize -> claim withdrawal queue.
///
/// Why not fork Lido or Rocket Pool (issue #38): their cores drag in Aragon / StakingRouter /
/// AccountingOracle (or RocketStorage) and beacon-chain assumptions, and the yield would still have
/// to be mocked -- a large deploy whose economic content is a mock anyway, paid for in state-dump
/// size and deploy time. So the *interface* is forked, not the implementation: ERC-4626
/// (`asset` / `totalAssets` / `convertToAssets` / `previewRedeem` / `deposit` / `redeem`) plus the
/// wstETH aliases (`stEthPerToken` / `getStETHByWstETH` / ...), so an agent can rely on prior
/// knowledge of those names.
///
/// Deliberate deviations from ERC-4626, both because a real LST has no instant at-par exit:
///   - `redeem` / `withdraw` **enqueue** a withdrawal instead of paying out; `claimWithdraw` pays.
///     `previewRedeem` therefore reports what the queue will eventually pay, not what you get now.
///     The instant exit is the LST/WETH secondary market, at whatever discount it is trading.
///   - `maxWithdraw` / `previewWithdraw` are omitted rather than given a misleading answer.
///
/// Two properties matter because agents here are adversarial:
///   - `totalPooledWeth` is internal accounting and is **never** `asset.balanceOf(address(this))`.
///     A direct WETH transfer to this contract is a donation to nobody: it cannot move the
///     exchange rate, so it cannot be used to grief or to inflate a share price.
///   - The first deposit is floored and burns a slice of shares to address(0xdead), so the classic
///     first-depositor share-inflation round-off is not available either.
contract MockLSTVault {
    // -----------------------------------------------------------------------
    // ERC-20 (the share token). Non-rebasing: balances never change on their own -- the exchange
    // rate does. A rebasing balance would break pool/LP accounting and historical scoring.
    // -----------------------------------------------------------------------
    string public constant name = "Eris Liquid Staked ETH";
    string public constant symbol = "ERLST";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // -----------------------------------------------------------------------
    // Vault state
    // -----------------------------------------------------------------------

    /// @notice ERC-4626 underlying asset (WETH).
    address public immutable asset;

    /// @notice WETH backing the outstanding shares. Internal accounting on purpose (see above).
    uint256 public totalPooledWeth;

    /// @notice Pre-funded, not-yet-distributed staking rewards. Yield is paid out of this rather
    ///         than minted, so a run can never accrue more than the environment funded.
    uint256 public rewardReserve;

    /// @notice WETH already earmarked for queued withdrawals. Held for claimants, not for stakers.
    uint256 public pendingWithdrawalWeth;

    /// @notice Per-block reward rate as a ray (1e27) fraction of `totalPooledWeth`. The environment
    ///         sets this from its economic clock (simulated seconds per block x target APY).
    uint256 public rewardRatePerBlockRay;

    /// @notice Block at which rewards were last accrued.
    uint256 public lastAccrualBlock;

    /// @notice Floor on how long a withdrawal request waits before it can be claimed.
    uint256 public withdrawalDelayBlocks;

    /// @notice How much queued WETH the protocol can finalize per block. 0 disables the limit, in
    ///         which case every request simply waits `withdrawalDelayBlocks` (phase 1 behaviour).
    ///
    /// A real withdrawal queue is rate-limited by how fast the protocol can free capital, and it
    /// finalizes in order. That makes the wait depend on two things a staker has to reason about:
    /// how much is already queued ahead of them, and how large their own exit is. Without it the
    /// queue is a fixed toll and the exit decision has no size to it (issue #38 phase 2).
    uint256 public queueThroughputWeiPerBlock;

    /// @notice The block the queue is currently booked out to. Requests stack after it, so a large
    ///         exit pushes back everyone who queues later -- including its own owner next time.
    uint256 public queueDrainBlock;

    /// @notice Accounts allowed to reconfigure the vault (rate / delay) and to slash. Accrual itself
    ///         is permissionless -- see `accrueRewards`.
    mapping(address => bool) public operators;

    uint256 private constant RAY = 1e27;
    /// @notice Floor on the very first deposit, so the initial exchange rate cannot be set by dust.
    uint256 public constant MIN_INITIAL_DEPOSIT = 1e15;
    /// @notice Shares burnt on the first deposit so the supply can never return to (near) zero.
    uint256 public constant BOOTSTRAP_BURN_SHARES = 1e6;
    address private constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    struct WithdrawalRequest {
        address owner;
        uint256 shares;
        /// @notice WETH locked in at request time. The queue pays par: later yield or slashing does
        ///         not move an already-queued request (Lido finalizes at the request-time rate).
        uint256 assets;
        uint256 claimableAt;
        bool claimed;
    }

    WithdrawalRequest[] public withdrawalRequests;
    mapping(address => uint256[]) private _requestIdsOf;
    /// @notice Requests that exist but have not been claimed (the queue's length).
    uint256 public openRequestCount;

    event Deposited(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event WithdrawalRequested(
        address indexed owner, uint256 indexed requestId, uint256 shares, uint256 assets, uint256 claimableAt
    );
    event WithdrawalClaimed(address indexed owner, uint256 indexed requestId, uint256 assets);
    event RewardsAccrued(uint256 assets, uint256 totalPooledWeth, uint256 rewardReserve);
    event RewardsFunded(address indexed from, uint256 assets, uint256 rewardReserve);
    event Slashed(uint256 assets, uint256 totalPooledWeth);
    event RewardRateSet(uint256 rewardRatePerBlockRay);
    event WithdrawalDelaySet(uint256 withdrawalDelayBlocks);
    event QueueThroughputSet(uint256 queueThroughputWeiPerBlock);
    event OperatorSet(address indexed account, bool allowed);

    modifier onlyOperator() {
        require(operators[msg.sender], "LST: not operator");
        _;
    }

    /// @param _asset          underlying WETH
    /// @param _envOperator    a second operator besides the deployer (the simulation's admin key),
    ///                        so the environment can retune the clock without redeploying
    /// @param _rewardRatePerBlockRay initial per-block reward rate (ray)
    /// @param _withdrawalDelayBlocks initial queue delay
    constructor(
        address _asset,
        address _envOperator,
        uint256 _rewardRatePerBlockRay,
        uint256 _withdrawalDelayBlocks
    ) {
        require(_asset != address(0), "LST: asset required");
        asset = _asset;
        operators[msg.sender] = true;
        emit OperatorSet(msg.sender, true);
        if (_envOperator != address(0) && _envOperator != msg.sender) {
            operators[_envOperator] = true;
            emit OperatorSet(_envOperator, true);
        }
        rewardRatePerBlockRay = _rewardRatePerBlockRay;
        withdrawalDelayBlocks = _withdrawalDelayBlocks;
        lastAccrualBlock = block.number;
        emit RewardRateSet(_rewardRatePerBlockRay);
        emit WithdrawalDelaySet(_withdrawalDelayBlocks);
    }

    // -----------------------------------------------------------------------
    // ERC-4626 style views
    // -----------------------------------------------------------------------

    function totalAssets() public view returns (uint256) {
        return totalPooledWeth;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0 || totalPooledWeth == 0) return assets;
        return (assets * supply) / totalPooledWeth;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0 || totalPooledWeth == 0) return shares;
        return (shares * totalPooledWeth) / supply;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    /// @notice What the withdrawal queue would eventually pay for `shares`. NOT an instant quote:
    ///         redeeming enqueues, and the payout lands `withdrawalDelayBlocks` later.
    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    // ---- wstETH aliases (so prior knowledge of the real thing transfers) ----

    /// @notice WETH per 1e18 shares -- the redemption rate. This is the function the Curve
    ///         stableswap-ng pool is wired to call as its rate oracle.
    function stEthPerToken() public view returns (uint256) {
        return convertToAssets(1e18);
    }

    function tokensPerStEth() external view returns (uint256) {
        return convertToShares(1e18);
    }

    function getStETHByWstETH(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function getWstETHByStETH(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    // -----------------------------------------------------------------------
    // Staking
    // -----------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {
        require(assets > 0, "LST: zero assets");
        require(receiver != address(0), "LST: zero receiver");
        bool bootstrap = totalSupply == 0;
        if (bootstrap) require(assets >= MIN_INITIAL_DEPOSIT, "LST: initial deposit too small");
        shares = convertToShares(assets);
        require(shares > 0, "LST: zero shares");
        require(IVaultAsset(asset).transferFrom(msg.sender, address(this), assets), "LST: transfer failed");
        totalPooledWeth += assets;
        if (bootstrap) {
            // Lock a slice of the first mint away so the supply cannot be squeezed back down to a
            // handful of wei, which is what makes share-price round-off exploitable.
            require(shares > BOOTSTRAP_BURN_SHARES, "LST: initial deposit too small");
            shares -= BOOTSTRAP_BURN_SHARES;
            _mint(BURN_ADDRESS, BOOTSTRAP_BURN_SHARES);
        }
        _mint(receiver, shares);
        emit Deposited(msg.sender, receiver, assets, shares);
    }

    function deposit(uint256 assets) external returns (uint256) {
        return deposit(assets, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Withdrawal queue (request -> finalize -> claim)
    // -----------------------------------------------------------------------

    /// @notice When a redemption of `assets` requested right now would become claimable.
    ///
    /// The floor is `withdrawalDelayBlocks`, but once a throughput limit is set the request also
    /// has to wait for whatever is queued ahead of it and then for its own size to drain. Exposed
    /// so an agent can price the wait before committing to it, rather than discovering it after.
    function estimateClaimableAt(uint256 assets) public view returns (uint256) {
        uint256 floorBlock = block.number + withdrawalDelayBlocks;
        uint256 throughput = queueThroughputWeiPerBlock;
        if (throughput == 0) return floorBlock;
        uint256 start = queueDrainBlock > floorBlock ? queueDrainBlock : floorBlock;
        // Round up: a partial block of draining still costs a block.
        return start + (assets + throughput - 1) / throughput;
    }

    /// @notice Blocks a redemption of `assets` would wait if requested now.
    function estimateDelayBlocks(uint256 assets) external view returns (uint256) {
        return estimateClaimableAt(assets) - block.number;
    }

    /// @notice Burn `shares` and join the withdrawal queue at today's rate. Claimable once the
    ///         queue reaches it (see `estimateClaimableAt`); the alternative is selling into the
    ///         secondary market now, at whatever discount it quotes.
    function requestWithdraw(uint256 shares) public returns (uint256 requestId) {
        require(shares > 0, "LST: zero shares");
        uint256 assets = convertToAssets(shares);
        require(assets > 0, "LST: zero assets");
        require(assets <= totalPooledWeth, "LST: insufficient pool");
        _burn(msg.sender, shares);
        totalPooledWeth -= assets;
        pendingWithdrawalWeth += assets;
        requestId = withdrawalRequests.length;
        uint256 claimableAt = estimateClaimableAt(assets);
        if (queueThroughputWeiPerBlock > 0) queueDrainBlock = claimableAt;
        withdrawalRequests.push(
            WithdrawalRequest({
                owner: msg.sender,
                shares: shares,
                assets: assets,
                claimableAt: claimableAt,
                claimed: false
            })
        );
        _requestIdsOf[msg.sender].push(requestId);
        openRequestCount += 1;
        emit WithdrawalRequested(msg.sender, requestId, shares, assets, claimableAt);
    }

    /// @notice ERC-4626 shaped, but this vault has no instant exit: it enqueues like
    ///         `requestWithdraw` and returns the assets the queue will pay.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(receiver == msg.sender && owner == msg.sender, "LST: only self redeem");
        uint256 requestId = requestWithdraw(shares);
        return withdrawalRequests[requestId].assets;
    }

    /// @notice ERC-4626 shaped withdraw-by-assets. Also enqueues.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(receiver == msg.sender && owner == msg.sender, "LST: only self withdraw");
        shares = convertToShares(assets);
        require(shares > 0, "LST: zero shares");
        requestWithdraw(shares);
    }

    function claimWithdraw(uint256 requestId) public returns (uint256 assets) {
        require(requestId < withdrawalRequests.length, "LST: no such request");
        WithdrawalRequest storage request = withdrawalRequests[requestId];
        require(request.owner == msg.sender, "LST: not request owner");
        require(!request.claimed, "LST: already claimed");
        require(block.number >= request.claimableAt, "LST: not finalized");
        request.claimed = true;
        assets = request.assets;
        pendingWithdrawalWeth -= assets;
        openRequestCount -= 1;
        require(IVaultAsset(asset).transfer(msg.sender, assets), "LST: transfer failed");
        emit WithdrawalClaimed(msg.sender, requestId, assets);
    }

    /// @notice Claim every finalized request of the caller. Convenient for an agent that queued a
    ///         few exits and just wants whatever is ready.
    function claimAllWithdrawals() external returns (uint256 assets) {
        uint256[] storage ids = _requestIdsOf[msg.sender];
        for (uint256 i = 0; i < ids.length; i++) {
            WithdrawalRequest storage request = withdrawalRequests[ids[i]];
            if (request.claimed || block.number < request.claimableAt) continue;
            assets += claimWithdraw(ids[i]);
        }
    }

    // ---- queue views ----

    function requestIdsOf(address owner) external view returns (uint256[] memory) {
        return _requestIdsOf[owner];
    }

    function withdrawalRequestCount() external view returns (uint256) {
        return withdrawalRequests.length;
    }

    /// @notice One-read summary of an account's LST position, so observation and post-run scoring
    ///         can both take it in a single batched call.
    /// @return shares            share balance
    /// @return shareAssets       what those shares redeem for at the current rate
    /// @return pendingAssets     queued WETH not yet claimable
    /// @return claimableAssets   queued WETH claimable right now
    /// @return nextClaimableAt   block at which the earliest unclaimable request finalizes (0 if none)
    /// @return openRequests      unclaimed requests belonging to this account
    function accountSummary(address owner)
        external
        view
        returns (
            uint256 shares,
            uint256 shareAssets,
            uint256 pendingAssets,
            uint256 claimableAssets,
            uint256 nextClaimableAt,
            uint256 openRequests
        )
    {
        shares = balanceOf[owner];
        shareAssets = convertToAssets(shares);
        uint256[] storage ids = _requestIdsOf[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            WithdrawalRequest storage request = withdrawalRequests[ids[i]];
            if (request.claimed) continue;
            openRequests += 1;
            if (block.number >= request.claimableAt) {
                claimableAssets += request.assets;
            } else {
                pendingAssets += request.assets;
                if (nextClaimableAt == 0 || request.claimableAt < nextClaimableAt) {
                    nextClaimableAt = request.claimableAt;
                }
            }
        }
    }

    /// @notice Like `accountSummary`, but splits the queued-but-unclaimable WETH by whether it
    ///         finalizes at or before `horizonBlock`.
    ///
    /// Post-run scoring marks an LST position at what it could actually realize, and a redemption
    /// that finalizes after the run ends cannot be realized inside it. Doing that split on-chain
    /// keeps it to one batched read per agent per block instead of walking the queue off-chain.
    function accountSummaryAt(address owner, uint256 horizonBlock)
        external
        view
        returns (
            uint256 shares,
            uint256 shareAssets,
            uint256 claimableAssets,
            uint256 reachableAssets,
            uint256 unreachableAssets,
            uint256 openRequests
        )
    {
        shares = balanceOf[owner];
        shareAssets = convertToAssets(shares);
        uint256[] storage ids = _requestIdsOf[owner];
        for (uint256 i = 0; i < ids.length; i++) {
            WithdrawalRequest storage request = withdrawalRequests[ids[i]];
            if (request.claimed) continue;
            openRequests += 1;
            if (block.number >= request.claimableAt) {
                claimableAssets += request.assets;
            } else if (request.claimableAt <= horizonBlock) {
                reachableAssets += request.assets;
            } else {
                unreachableAssets += request.assets;
            }
        }
    }

    /// @notice Every unclaimed request of an account, in one read (for the agent's observation).
    function openRequestsOf(address owner)
        external
        view
        returns (uint256[] memory ids, uint256[] memory assets, uint256[] memory claimableAt)
    {
        uint256[] storage all = _requestIdsOf[owner];
        uint256 open = 0;
        for (uint256 i = 0; i < all.length; i++) {
            if (!withdrawalRequests[all[i]].claimed) open += 1;
        }
        ids = new uint256[](open);
        assets = new uint256[](open);
        claimableAt = new uint256[](open);
        uint256 k = 0;
        for (uint256 i = 0; i < all.length; i++) {
            WithdrawalRequest storage request = withdrawalRequests[all[i]];
            if (request.claimed) continue;
            ids[k] = all[i];
            assets[k] = request.assets;
            claimableAt[k] = request.claimableAt;
            k += 1;
        }
    }

    // -----------------------------------------------------------------------
    // Yield
    // -----------------------------------------------------------------------

    /// @notice Move funded rewards into the pool for the blocks elapsed since the last accrual.
    ///
    /// Permissionless on purpose: the amount is a pure function of blocks elapsed and the
    /// configured rate, so no caller can manufacture yield by calling it more often, and an agent
    /// poking it does not gain anything over one that waits. The environment calls it every block
    /// so the rate an observation reports is never stale.
    function accrueRewards() public returns (uint256 accrued) {
        uint256 elapsed = block.number - lastAccrualBlock;
        if (elapsed == 0) return 0;
        lastAccrualBlock = block.number;
        if (totalSupply == 0 || rewardRatePerBlockRay == 0 || rewardReserve == 0) return 0;
        accrued = (totalPooledWeth * rewardRatePerBlockRay * elapsed) / RAY;
        if (accrued > rewardReserve) accrued = rewardReserve;
        if (accrued == 0) return 0;
        rewardReserve -= accrued;
        totalPooledWeth += accrued;
        emit RewardsAccrued(accrued, totalPooledWeth, rewardReserve);
    }

    /// @notice Fund the reward reserve. Pulls WETH in explicitly: a bare `transfer` to this
    ///         contract is not funding, and does not move the exchange rate.
    function fundRewards(uint256 assets) external {
        require(assets > 0, "LST: zero assets");
        require(IVaultAsset(asset).transferFrom(msg.sender, address(this), assets), "LST: transfer failed");
        rewardReserve += assets;
        emit RewardsFunded(msg.sender, assets, rewardReserve);
    }

    /// @notice Cut the pool by `bps` (a staking penalty; the stress overlay's LST event in phase 2).
    ///         The WETH returns to the reward reserve rather than leaving, so the vault stays
    ///         solvent against its outstanding shares and queued claims.
    function slash(uint256 bps) external onlyOperator returns (uint256 slashed) {
        require(bps <= 10_000, "LST: bps out of range");
        accrueRewards();
        slashed = (totalPooledWeth * bps) / 10_000;
        if (slashed == 0) return 0;
        totalPooledWeth -= slashed;
        rewardReserve += slashed;
        emit Slashed(slashed, totalPooledWeth);
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    function setRewardRate(uint256 ratePerBlockRay) external onlyOperator {
        // Settle at the old rate first, otherwise the new rate would retroactively reprice blocks
        // that already elapsed.
        accrueRewards();
        rewardRatePerBlockRay = ratePerBlockRay;
        emit RewardRateSet(ratePerBlockRay);
    }

    function setWithdrawalDelayBlocks(uint256 delayBlocks) external onlyOperator {
        withdrawalDelayBlocks = delayBlocks;
        emit WithdrawalDelaySet(delayBlocks);
    }

    function setQueueThroughput(uint256 weiPerBlock) external onlyOperator {
        queueThroughputWeiPerBlock = weiPerBlock;
        emit QueueThroughputSet(weiPerBlock);
    }

    function setOperator(address account, bool allowed) external onlyOperator {
        operators[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    /// @notice Everything the environment and an agent need about the vault, in one read.
    function vaultSummary()
        external
        view
        returns (
            uint256 pooledWeth,
            uint256 shareSupply,
            uint256 redemptionRate,
            uint256 reserve,
            uint256 queuedWeth,
            uint256 queueLength,
            uint256 delayBlocks,
            uint256 ratePerBlockRay,
            uint256 throughputWeiPerBlock,
            uint256 drainBlock
        )
    {
        return (
            totalPooledWeth,
            totalSupply,
            stEthPerToken(),
            rewardReserve,
            pendingWithdrawalWeth,
            openRequestCount,
            withdrawalDelayBlocks,
            rewardRatePerBlockRay,
            queueThroughputWeiPerBlock,
            queueDrainBlock
        );
    }

    /// @notice WETH held minus every obligation. Must never be negative; exposed so a run can
    ///         assert it rather than trust it.
    function surplusWeth() external view returns (uint256) {
        uint256 held = IVaultAsset(asset).balanceOf(address(this));
        uint256 owed = totalPooledWeth + pendingWithdrawalWeth + rewardReserve;
        return held > owed ? held - owed : 0;
    }

    // -----------------------------------------------------------------------
    // ERC-20 internals
    // -----------------------------------------------------------------------

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "LST: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "LST: zero receiver");
        require(balanceOf[from] >= amount, "LST: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "LST: insufficient balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}
