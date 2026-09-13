// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/LPFeeLibrary.sol";
import {SafeCast} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/SafeCast.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {IFeeController} from "../interfaces/IFeeController.sol";

/// @title DeedHookPrototype
/// @notice Feasibility prototype for a 5 bps total fee split 60/40 between LPs and DEEDS.
/// @dev Production fee control and distribution are intentionally excluded until this accounting path is proven.
contract DeedHookPrototype is BaseHook {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    uint256 private constant PIPS_DENOMINATOR = 1_000_000;
    IFeeController public immutable feeController;
    address public immutable admin;
    mapping(PoolId poolId => bytes32 ticker) public poolTicker;

    event SurchargeTaken(address indexed currency, uint256 amount);
    event PoolConfigured(PoolId indexed poolId, bytes32 indexed ticker);
    error PoolNotConfigured(PoolId poolId);
    error UnauthorizedAdmin(address caller);

    constructor(IPoolManager manager, address feeController_, address owner_) BaseHook(manager) {
        feeController = IFeeController(feeController_);
        admin = owner_;
    }

    function setPoolTicker(PoolKey calldata key, bytes32 ticker) external {
        if (msg.sender != admin) revert UnauthorizedAdmin(msg.sender);
        poolTicker[key.toId()] = ticker;
        emit PoolConfigured(key.toId(), ticker);
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
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
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
        bytes32 ticker = poolTicker[key.toId()];
        if (ticker == bytes32(0)) revert PoolNotConfigured(key.toId());
        uint24 lpFeePips = feeController.feeBps(ticker) * 60;
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            lpFeePips | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        bool specifiedTokenIs0 = params.amountSpecified < 0 == params.zeroForOne;
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        bytes32 ticker = poolTicker[key.toId()];
        if (ticker == bytes32(0)) revert PoolNotConfigured(key.toId());
        uint256 surchargePips = uint256(feeController.feeBps(ticker)) * 40;
        uint256 feeAmount = uint128(swapAmount) * surchargePips / PIPS_DENOMINATOR;
        poolManager.take(feeCurrency, address(this), feeAmount);
        emit SurchargeTaken(Currency.unwrap(feeCurrency), feeAmount);

        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }
}

/// @dev Allows ordinary deployment before copying runtime bytecode to a correctly flagged hook address in local tests.
contract DeedHookPrototypeHarness is DeedHookPrototype {
    constructor(IPoolManager manager, address feeController, address owner)
        DeedHookPrototype(manager, feeController, owner)
    {}

    function validateHookAddress(BaseHook) internal pure override {}
}
