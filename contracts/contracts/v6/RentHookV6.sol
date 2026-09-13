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

/// @title DEEDS v6 RentHook
/// @notice Ensures the RENT/ETH pool can only be swapped through its ETH fee-accounting router.
contract RentHookV6 is BaseHook {
    using PoolIdLibrary for PoolKey;

    address public immutable initialAdmin;
    address private _admin;
    mapping(PoolId poolId => address router) public poolRouter;

    error UnauthorizedAdmin(address caller);
    error InvalidAdmin();
    error PoolNotConfigured(PoolId poolId);
    error RouterOnly(address caller, address expected);
    event PoolConfigured(PoolId indexed poolId, address indexed router);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    constructor(IPoolManager manager, address admin_) BaseHook(manager) {
        if (admin_ == address(0)) revert InvalidAdmin();
        initialAdmin = admin_;
        _admin = admin_;
    }

    function admin() public view returns (address) { return _admin == address(0) ? initialAdmin : _admin; }

    /// @notice Moves the one-shot pool-configuration authority to governance.
    /// Existing pool/router bindings remain immutable.
    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin()) revert UnauthorizedAdmin(msg.sender);
        if (newAdmin == address(0)) revert InvalidAdmin();
        address previous = admin();
        _admin = newAdmin;
        emit AdminTransferred(previous, newAdmin);
    }

    function configurePool(PoolKey calldata key, address router) external {
        if (msg.sender != admin()) revert UnauthorizedAdmin(msg.sender);
        PoolId poolId = key.toId();
        if (poolRouter[poolId] != address(0)) revert PoolNotConfigured(poolId);
        poolRouter[poolId] = router;
        emit PoolConfigured(poolId, router);
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

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address router = poolRouter[key.toId()];
        if (router == address(0)) revert PoolNotConfigured(key.toId());
        if (sender != router) revert RouterOnly(sender, router);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}

contract RentHookV6Harness is RentHookV6 {
    constructor(IPoolManager manager, address admin) RentHookV6(manager, admin) {}
    function validateHookAddress(BaseHook) internal pure override {}
}
