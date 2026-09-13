// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// These official Uniswap contracts are compiled only to support the Hardhat integration suite.
import {PoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-periphery/lib/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-periphery/lib/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TestERC20} from "@uniswap/v4-periphery/lib/v4-core/src/test/TestERC20.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";

contract V4PoolManager is PoolManager {
    constructor(address initialOwner) PoolManager(initialOwner) {}
}

contract V4SwapRouter is PoolSwapTest {
    constructor(IPoolManager manager) PoolSwapTest(manager) {}
}

contract V4LiquidityRouter is PoolModifyLiquidityTest {
    constructor(IPoolManager manager) PoolModifyLiquidityTest(manager) {}
}

contract V4TestToken is TestERC20 {
    constructor(uint256 amountToMint) TestERC20(amountToMint) {}
}
