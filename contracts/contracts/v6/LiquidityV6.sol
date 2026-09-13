// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {RentFeeRouterV6} from "./RentFeeRouterV6.sol";

interface IBucketSourceV6 { function claimBucket() external returns (uint256); }
interface ISaleSourceV6 { function claimSaleFee() external returns (uint256); }

/// @notice A full-range position owned by this contract. There is deliberately no removal,
/// arbitrary call, token approval, or principal rescue authority, including for the governor.
contract LiquidityV6 is Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;
    RentFeeRouterV6 public router;
    address public executor;
    uint128 public totalLiquidity;
    bool private _adding;
    mapping(address => uint8) public sources;
    event LiquidityAdded(uint128 liquidity, uint128 total);
    constructor(address governor, address executor_) Ownable(governor) { executor = executor_; }
    function configureRouter(address value) external onlyOwner {
        require(address(router) == address(0) && value.code.length != 0, "Router frozen");
        router = RentFeeRouterV6(payable(value));
    }
    function configureSource(address source, uint8 kind) external onlyOwner {
        require(source.code.length != 0 && kind <= 2, "Invalid source"); sources[source] = kind;
    }
    function setExecutor(address value) external onlyOwner { require(value != address(0), "Invalid executor"); executor = value; }
    function pull(address source) external nonReentrant {
        uint8 kind = sources[source]; require(kind != 0, "Unknown source");
        if (kind == 1) IBucketSourceV6(source).claimBucket(); else ISaleSourceV6(source).claimSaleFee();
    }
    function reinvest(uint256 ethToSwap, uint256 minRent, uint256 maxEth, uint256 maxRent,
        uint128 minLiquidity, uint256 deadline) external nonReentrant returns (uint128 liquidity) {
        require(msg.sender == executor && deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "Invalid execution");
        require(minLiquidity > 0 && maxEth <= address(this).balance, "Invalid bounds");
        if (ethToSwap != 0) {
            require(minRent != 0 && ethToSwap <= maxEth / 2, "Invalid rebalance");
            router.swapExactInputEthForRent{value: ethToSwap}(minRent, deadline);
            maxEth -= ethToSwap;
        }
        IPoolManager manager = router.poolManager();
        PoolKey memory key = router.poolKey();
        require(maxRent <= IERC20(address(router.rent())).balanceOf(address(this)), "Insufficient RENT");
        (uint160 price,,,) = manager.getSlot0(key.toId());
        liquidity = LiquidityAmounts.getLiquidityForAmounts(price, TickMath.getSqrtPriceAtTick(-887220),
            TickMath.getSqrtPriceAtTick(887220), maxEth, maxRent);
        require(liquidity >= minLiquidity, "Liquidity slippage");
        _adding = true;
        manager.unlock(abi.encode(liquidity, maxEth, maxRent));
        _adding = false;
        totalLiquidity += liquidity;
        emit LiquidityAdded(liquidity, totalLiquidity);
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        IPoolManager manager = router.poolManager();
        require(msg.sender == address(manager) && _adding, "Only manager");
        (uint128 liquidity, uint256 maxEth, uint256 maxRent) = abi.decode(data, (uint128, uint256, uint256));
        PoolKey memory key = router.poolKey();
        (BalanceDelta delta,) = manager.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, int256(uint256(liquidity)), bytes32(0)), "");
        int128 ethDelta = delta.amount0(); int128 rentDelta = delta.amount1();
        if (ethDelta < 0) {
            uint256 owed = uint256(uint128(-ethDelta)); require(owed <= maxEth, "ETH bound");
            manager.settle{value: owed}();
        } else if (ethDelta > 0) manager.take(key.currency0, address(this), uint256(uint128(ethDelta)));
        if (rentDelta < 0) {
            uint256 owed = uint256(uint128(-rentDelta)); require(owed <= maxRent, "RENT bound");
            manager.sync(key.currency1);
            IERC20(address(router.rent())).safeTransfer(address(manager), owed);
            manager.settle();
        } else if (rentDelta > 0) manager.take(key.currency1, address(this), uint256(uint128(rentDelta)));
        return "";
    }
    receive() external payable {}
}

contract RentBuyBurnV6 is Ownable, ReentrancyGuard {
    RentFeeRouterV6 public router;
    address public vault;
    address public executor;
    uint256 public totalBurned;
    uint256 public totalEthSpent;
    event BurnExecuted(uint256 ethAmount, uint256 rentAmount);
    event BurnDeferred(uint256 ethAmount, bytes reason);
    constructor(address governor, address executor_) Ownable(governor) { executor = executor_; }
    function configure(address router_, address vault_) external onlyOwner {
        require(address(router) == address(0) && router_.code.length != 0 && vault_.code.length != 0, "Configuration frozen");
        router = RentFeeRouterV6(payable(router_)); vault = vault_;
    }
    function setExecutor(address value) external onlyOwner { require(value != address(0), "Invalid executor"); executor = value; }
    function pull() external nonReentrant { IBucketSourceV6(vault).claimBucket(); }
    function execute(uint256 amount, uint256 minimum, uint256 deadline) external nonReentrant returns (bool) {
        require(msg.sender == executor && amount != 0 && amount <= address(this).balance && minimum != 0, "Invalid execution");
        require(deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "Invalid deadline");
        try this.swapAndBurn(amount, minimum, deadline) returns (uint256 burned) {
            totalBurned += burned; totalEthSpent += amount; emit BurnExecuted(amount, burned); return true;
        } catch (bytes memory reason) { emit BurnDeferred(amount, reason); return false; }
    }
    function swapAndBurn(uint256 amount, uint256 minimum, uint256 deadline) external returns (uint256 burned) {
        require(msg.sender == address(this), "Only self");
        burned = router.swapExactInputEthForRent{value: amount}(minimum, deadline);
        IRentSelfBurnV6(address(router.rent())).burn(burned);
    }
    receive() external payable { require(msg.sender == vault, "Only vault"); }
}
interface IRentSelfBurnV6 { function burn(uint256 amount) external; }
