// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title MarketRegistry
/// @notice The second instance of the PriceFeed pattern (issue #40): the environment observes
///         off-chain what contracts agents have deployed and publishes the list on-chain, so every
///         agent reads the same set from the same place.
///
///         It inherits PriceFeed's one-block distribution lag — the coordinator's write lands in the
///         next block — so a creator knows about its own contract one block before anyone else. That
///         head start is the incentive to build, and it applies equally to everyone.
///
///         **The registry is a discovery mechanism, not a verification mechanism.** `verified` means
///         only "this came out of a factory whose implementation the environment deployed, with
///         parameters the environment can read". Everything else is `unknown`: listed, carrying no
///         safety claim. Losing money to an unverified contract is a legitimate loss.
///
///         The codehash is recorded **at registration** and never refreshed. Under the round-trip
///         scoring rule a proxy swapped out between observation and execution is just another way of
///         not getting out, so policing it is the agent's job — `eth_getCode` is callable by anyone,
///         and noticing the change is a skill difference rather than a service.
contract MarketRegistry {
    /// What kind of thing an entry is. `Unknown` is the honest default: it means the environment
    /// saw a contract appear and can say nothing else about it.
    enum Kind {
        Unknown,
        UniswapV3Pool,
        BalancerWeightedPool,
        CurvePlainPool,
        CurveTwocryptoPool,
        LendingMarket,
        Erc20
    }

    struct Entry {
        address market;
        Kind kind;
        address creator;
        // Tokens where known (factory logs give them directly). Zero for an arbitrary contract.
        address token0;
        address token1;
        // Lending markets only: the market's price source, and the parameter a verifier reads first.
        address oracle;
        // keccak256(eth_getCode(market)) at the block the entry was registered.
        bytes32 codehash;
        bool verified;
        uint64 registeredAtBlock;
        // Kind-specific handle: the lending marketId, a Balancer poolId, 0 otherwise.
        bytes32 extra;
    }

    address public immutable owner;

    Entry[] private _entries;
    /// keccak256(market, extra) -> index+1. Keyed on the pair rather than on the address alone
    /// because one address can carry many entries: every market on the permissionless lending
    /// singleton lives at the singleton's address and is told apart by its `extra` (the marketId).
    mapping(bytes32 => uint256) private _indexPlusOne;
    /// address -> index+1 of its first entry. What `isRegistered` / `indexOf` answer.
    mapping(address => uint256) private _firstIndexPlusOne;

    event MarketRegistered(
        address indexed market,
        Kind indexed kind,
        address indexed creator,
        address token0,
        address token1,
        address oracle,
        bytes32 codehash,
        bool verified,
        bytes32 extra,
        uint256 blockNumber
    );

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Publish a batch of entries. Owner-gated (the environment's admin wallet) for the same
    ///         reason PriceFeed's writes are: an agent that could write here could publish a
    ///         `verified` entry for its own trap.
    /// @dev Already-registered markets are skipped rather than reverting, so one duplicate in a
    ///      batch cannot drop the rest of the block's discoveries.
    function register(Entry[] calldata entries) external {
        if (msg.sender != owner) revert NotOwner();
        for (uint256 i = 0; i < entries.length; i++) {
            Entry calldata e = entries[i];
            if (e.market == address(0)) continue;
            bytes32 k = keccak256(abi.encodePacked(e.market, e.extra));
            if (_indexPlusOne[k] != 0) continue;
            _entries.push(
                Entry({
                    market: e.market,
                    kind: e.kind,
                    creator: e.creator,
                    token0: e.token0,
                    token1: e.token1,
                    oracle: e.oracle,
                    codehash: e.codehash,
                    verified: e.verified,
                    registeredAtBlock: uint64(block.number),
                    extra: e.extra
                })
            );
            _indexPlusOne[k] = _entries.length;
            if (_firstIndexPlusOne[e.market] == 0)
                _firstIndexPlusOne[e.market] = _entries.length;
            emit MarketRegistered(
                e.market,
                e.kind,
                e.creator,
                e.token0,
                e.token1,
                e.oracle,
                e.codehash,
                e.verified,
                e.extra,
                block.number
            );
        }
    }

    function count() external view returns (uint256) {
        return _entries.length;
    }

    function all() external view returns (Entry[] memory) {
        return _entries;
    }

    /// @notice A window of the list, for readers that do not want the whole array in one call.
    function entriesFrom(
        uint256 start,
        uint256 limit
    ) external view returns (Entry[] memory out) {
        uint256 n = _entries.length;
        if (start >= n) return new Entry[](0);
        uint256 end = start + limit;
        if (end > n) end = n;
        out = new Entry[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = _entries[i];
    }

    function entryAt(uint256 index) external view returns (Entry memory) {
        return _entries[index];
    }

    function isRegistered(address market) external view returns (bool) {
        return _firstIndexPlusOne[market] != 0;
    }

    /// @notice Index of a market's first entry, or type(uint256).max when it is not registered.
    ///         An address with several entries (the lending singleton) needs `all()` to see them.
    function indexOf(address market) external view returns (uint256) {
        uint256 i = _firstIndexPlusOne[market];
        return i == 0 ? type(uint256).max : i - 1;
    }

    /// @notice Whether this exact (market, extra) pair has been published.
    function isEntryRegistered(
        address market,
        bytes32 extra
    ) external view returns (bool) {
        return _indexPlusOne[keccak256(abi.encodePacked(market, extra))] != 0;
    }
}
