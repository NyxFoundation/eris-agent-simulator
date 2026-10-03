// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: factory that spawns the new pools for vulnerability events.
// During a run the environment spawns a mix of SimpleAMM (honest) / RiggedAMM (malicious) and emits
// PoolCreated on-chain. Agents build the pool graph by subscribing to factory events (§3).
//
// One entry point for both kinds. The factory used to have createSimplePool / createRiggedPool, so
// the creating transaction's selector named the answer -- and the rigged one carried the skim
// threshold and fraction as plain arguments. Now the calldata is the pool's init code, which says
// no more than the pool's own bytecode does once it exists: telling the two apart takes reading it.
//
// The environment's pool wallet owns the factory and deploys each pool at its window (not at setup),
// so no pool exists before its window opens. The factory itself is deployed in every run, vuln or
// not, so its presence says nothing about the regime either.
//
// PoolCreated does not expose the rigged flag; the ground-truth lives in the environment's
// events.jsonl (for scoring). Token pair and fee are read back from the pool, not taken on trust.

interface ILiquidityPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function feeBps() external view returns (uint24);
}

/// @title VulnPoolFactory
/// @notice Only the owner (the environment's pool wallet) can create pools. Appends to allPools in creation order.
contract VulnPoolFactory {
    address public immutable owner;
    address[] public allPools;

    // Does not expose rigged. tokens / fee only (matches a production explorer's by-address lookup).
    event PoolCreated(
        address indexed pool,
        address indexed token0,
        address indexed token1,
        uint24 feeBps
    );

    constructor(address _owner) {
        require(_owner != address(0), "owner");
        owner = _owner;
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    function createPool(bytes calldata initCode) external returns (address pool) {
        require(msg.sender == owner, "not owner");
        bytes memory code = initCode;
        assembly {
            pool := create(0, add(code, 0x20), mload(code))
        }
        require(pool != address(0), "create failed");
        address token0 = ILiquidityPool(pool).token0();
        address token1 = ILiquidityPool(pool).token1();
        require(token0 != token1, "same token");
        allPools.push(pool);
        emit PoolCreated(pool, token0, token1, ILiquidityPool(pool).feeBps());
    }
}
