// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: factory that spawns the new pools for vulnerability events.
// During a run the environment (coordinator) spawns a mix of SimpleAMM (honest) / RiggedAMM
// (malicious) and emits PoolCreated on-chain. Agents build the pool graph by subscribing to factory
// events (§3).
//
// Important: PoolCreated does not expose the rigged flag (token/fee only). Exposing it would break
// the design where pools can only be told apart by contract safety, trivializing verification
// (ADR 0014 §1). The rigged ground-truth is held separately by the environment in events.jsonl (for scoring).
// All execution logic lives on the TypeScript + viem side. Only this contract is compiled with Foundry.

import {SimpleAMM} from "./SimpleAMM.sol";
import {RiggedAMM} from "./RiggedAMM.sol";

/// @title VulnPoolFactory
/// @notice Only the owner (the environment's admin) can create pools. Appends to allPools in creation order.
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

    constructor() {
        owner = msg.sender;
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    function createSimplePool(
        address token0,
        address token1,
        uint24 feeBps
    ) external returns (address pool) {
        require(msg.sender == owner, "not owner");
        require(token0 != token1, "same token");
        pool = address(new SimpleAMM(token0, token1, feeBps));
        allPools.push(pool);
        emit PoolCreated(pool, token0, token1, feeBps);
    }

    function createRiggedPool(
        address token0,
        address token1,
        uint24 feeBps,
        uint256 rugThreshold,
        uint24 rugBps
    ) external returns (address pool) {
        require(msg.sender == owner, "not owner");
        require(token0 != token1, "same token");
        pool = address(
            new RiggedAMM(token0, token1, feeBps, rugThreshold, rugBps)
        );
        allPools.push(pool);
        emit PoolCreated(pool, token0, token1, feeBps);
    }
}
