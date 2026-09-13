// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-periphery/lib/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";

/// @title DEEDS v6 RENT fee router
/// @notice Exact-input RENT/ETH swaps with an exact 5% ETH protocol fee and 70/20/10 accounting.
interface ITradingFeeProcessor { function depositTradingFees() external payable; }

contract TradingRouter is IUnlockCallback, ReentrancyGuard, Ownable {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 500;
    uint256 public constant BPS = 10_000;

    error InvalidAddress();
    error InvalidPool();
    error DeadlineExpired(uint256 deadline);
    error ZeroInput();
    error Slippage(uint256 received, uint256 minimum);
    error OnlyPoolManager();
    error NoActiveSwap();
    error TransferFailed();
    error NotReceiver();

    struct CallbackData {
        address payer;
        address recipient;
        bool ethForRent;
        uint256 amountIn;
        uint256 minGrossOut;
    }

    IPoolManager public immutable poolManager;
    IERC20 public immutable rent;
    address public immutable hook;
    ITradingFeeProcessor public immutable feeProcessor;

    uint256 public stockBuyerAccrued;
    uint256 public liquidityAccrued;
    uint256 public teamAccrued;
    uint256 public totalFeesCollected;
    bool private _activeSwap;
    uint256 public launchAt;
    address public launchOracleVault;
    address public launchpad;
    bool public launchConfigured;
    bool public launchReady;
    bool public swapsPaused;
    address public guardian;
    mapping(address => uint256) public firstHourSpentUsd6;

    event SwapRouted(address indexed sender, bool ethForRent, uint256 input, uint256 output, uint256 ethFee);
    event FeeAccounted(uint256 fee, uint256 stockBuyer, uint256 liquidity, uint256 team);
    event BucketClaimed(address indexed receiver, uint256 amount);

    constructor(
        address poolManager_,
        address rent_,
        address hook_,
        address feeProcessor_
    ) Ownable(msg.sender) {
        if (
            poolManager_ == address(0) || rent_ == address(0) || hook_ == address(0)
                || feeProcessor_.code.length == 0
        ) revert InvalidAddress();
        poolManager = IPoolManager(poolManager_);
        rent = IERC20(rent_);
        hook = hook_;
        feeProcessor = ITradingFeeProcessor(feeProcessor_);
    }

    function configureLaunch(uint256 start, address oracleVault, address launchpad_) external onlyOwner {
        require(!launchConfigured && start >= block.timestamp && oracleVault.code.length != 0 && launchpad_.code.length != 0, "Invalid launch");
        launchConfigured = true; launchAt = start; launchOracleVault = oracleVault; launchpad = launchpad_;
    }
    function enableLaunch() external { require(msg.sender == launchpad && block.timestamp >= launchAt, "Launch unavailable"); launchReady = true; }
    function setGuardian(address value) external onlyOwner { guardian = value; }
    function pauseSwaps(bool value) external {
        require(msg.sender == owner() || (msg.sender == guardian && value), "Unauthorized pause"); swapsPaused = value;
    }
    function _launchCheck() private view {
        require(!swapsPaused && (!launchConfigured || (launchReady && block.timestamp >= launchAt)), "Trading closed");
    }

    function swapExactInputEthForRent(uint256 minRentOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 rentOut)
    {
        _checkDeadline(deadline);
        _launchCheck();
        if (launchConfigured && block.timestamp < launchAt + 1 hours) {
            uint256 oneUsd = ILaunchOracleV6(launchOracleVault).usdToEth(1e6);
            uint256 spent = (msg.value * 1e6 + oneUsd - 1) / oneUsd;
            require(firstHourSpentUsd6[msg.sender] + spent <= 50e6, "First hour cap");
            firstHourSpentUsd6[msg.sender] += spent;
        }
        if (msg.value == 0) revert ZeroInput();
        uint256 fee = msg.value * FEE_BPS / BPS;
        uint256 poolInput = msg.value - fee;
        _activeSwap = true;
        rentOut = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(msg.sender, msg.sender, true, poolInput, minRentOut))),
            (uint256)
        );
        _activeSwap = false;
        _accountFee(fee);
        emit SwapRouted(msg.sender, true, msg.value, rentOut, fee);
    }

    function swapExactInputRentForEth(uint256 rentIn, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 netEthOut)
    {
        _checkDeadline(deadline);
        _launchCheck();
        if (rentIn == 0) revert ZeroInput();
        _activeSwap = true;
        uint256 grossEthOut = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(msg.sender, address(this), false, rentIn, 0))),
            (uint256)
        );
        _activeSwap = false;
        uint256 fee = grossEthOut * FEE_BPS / BPS;
        netEthOut = grossEthOut - fee;
        if (netEthOut < minEthOut) revert Slippage(netEthOut, minEthOut);
        _accountFee(fee);
        _send(payable(msg.sender), netEthOut);
        emit SwapRouted(msg.sender, false, rentIn, netEthOut, fee);
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (!_activeSwap) revert NoActiveSwap();
        CallbackData memory data = abi.decode(rawData, (CallbackData));
        PoolKey memory key = poolKey();
        SwapParams memory params = SwapParams({
            zeroForOne: data.ethForRent,
            amountSpecified: -int256(data.amountIn),
            sqrtPriceLimitX96: data.ethForRent
                ? uint160(4_295_128_740)
                : uint160(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341)
        });
        BalanceDelta delta = poolManager.swap(key, params, "");
        if (data.ethForRent) {
            uint256 ethOwed = uint256(uint128(-delta.amount0()));
            require(ethOwed == data.amountIn, "Partial fill");
            uint256 rentOut = uint256(uint128(delta.amount1()));
            poolManager.settle{value: ethOwed}();
            poolManager.take(key.currency1, data.recipient, rentOut);
            if (rentOut < data.minGrossOut) revert Slippage(rentOut, data.minGrossOut);
            return abi.encode(rentOut);
        }

        uint256 rentOwed = uint256(uint128(-delta.amount1()));
        require(rentOwed == data.amountIn, "Partial fill");
        uint256 ethOut = uint256(uint128(delta.amount0()));
        poolManager.sync(key.currency1);
        rent.safeTransferFrom(data.payer, address(poolManager), rentOwed);
        poolManager.settle();
        poolManager.take(key.currency0, data.recipient, ethOut);
        return abi.encode(ethOut);
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(rent)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
    }

    function _accountFee(uint256 fee) internal {
        totalFeesCollected += fee;
        feeProcessor.depositTradingFees{value: fee}();
        emit FeeAccounted(fee, 0, 0, 0);
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
    }

    function _send(address payable receiver, uint256 amount) internal {
        (bool success,) = receiver.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
    }
}
interface ILaunchOracleV6 { function usdToEth(uint256 usd6) external view returns (uint256); }

/// @dev Legacy source-name compatibility only. New deployments use TradingRouter.
contract RentFeeRouterV6 is TradingRouter {
    constructor(address manager, address rent_, address hook_, address processor, address, address)
        TradingRouter(manager, rent_, hook_, processor) {}
    function claimBucket() external pure returns (uint256) { return 0; }
}
