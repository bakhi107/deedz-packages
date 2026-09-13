// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";

/// @title V6 RENT/ETH connectivity hook
/// @notice Restricts this hook to explicitly configured pools while the final fee router is developed.
/// @dev The test pool's static 5% fee remains with LPs. Production 70/20/9/1 ETH routing is NOT implemented here.
contract RentHookV6Prototype is BaseHook {
    using PoolIdLibrary for PoolKey;

    address public immutable admin;
    mapping(PoolId poolId => bool configured) public configuredPool;

    error UnauthorizedAdmin(address caller);
    error PoolNotConfigured(PoolId poolId);
    event PoolConfigured(PoolId indexed poolId);

    constructor(IPoolManager manager, address admin_) BaseHook(manager) {
        admin = admin_;
    }

    function configurePool(PoolKey calldata key) external {
        if (msg.sender != admin) revert UnauthorizedAdmin(msg.sender);
        PoolId poolId = key.toId();
        configuredPool[poolId] = true;
        emit PoolConfigured(poolId);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        if (!configuredPool[poolId]) revert PoolNotConfigured(poolId);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}

/// @dev Local-test harness; production deployment must mine an address with the correct hook flags.
contract RentHookV6PrototypeHarness is RentHookV6Prototype {
    constructor(IPoolManager manager, address admin) RentHookV6Prototype(manager, admin) {}

    function validateHookAddress(BaseHook) internal pure override {}
}
