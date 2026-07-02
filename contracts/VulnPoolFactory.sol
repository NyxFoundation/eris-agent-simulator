// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ADR 0014 §1: 脆弱性発生イベントの新規プールを生成する factory。
// 環境（coordinator）が run 中に SimpleAMM（正直）/ RiggedAMM（悪意）を混在生成し、
// PoolCreated を on-chain emit する。agent は factory イベント購読でプールグラフを作る（§3）。
//
// 重要: PoolCreated は rigged フラグを暴露しない（token/fee のみ）。暴露すると「契約の
// 安全性でしか区別できない」という設計が崩れて検証が trivialize する（ADR 0014 §1）。
// rigged の ground-truth は環境が events.jsonl に別途持つ（採点用）。
// 実行系はすべて TypeScript + viem 側。このコントラクトのみ Foundry でコンパイルする。

import {SimpleAMM} from "./SimpleAMM.sol";
import {RiggedAMM} from "./RiggedAMM.sol";

/// @title VulnPoolFactory
/// @notice owner（環境の admin）のみがプールを生成できる。生成順に allPools へ追記。
contract VulnPoolFactory {
    address public immutable owner;
    address[] public allPools;

    // rigged は暴露しない。tokens / fee のみ（本番 explorer の by-address 照会に対応）。
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
