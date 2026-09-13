// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {StockRewardsV6} from "./StockRewardsV6.sol";

interface ITradingFeeSourceV6 {
    function claimBucket() external returns (uint256 amount);
}

interface IStockSwapAdapterV6 {
    function swapExactEthForToken(address token, uint256 minAmountOut, uint256 deadline, bytes calldata routeData)
        external
        payable
        returns (uint256 amountOut);
}

/// @title DEEDS v6 StockBuyer
/// @notice Pulls the trading-fee bucket, allocates ETH by Lit weight, and buys allowlisted Stock Tokens.
contract StockBuyerV6 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error AlreadyConfigured();
    error UnsupportedTicker(bytes32 ticker);
    error OnlyExecutor();
    error NoLitWeight();
    error NoAllocation(bytes32 ticker);
    error DeadlineExpired(uint256 deadline);
    error Slippage(uint256 received, uint256 minimum);
    error IncorrectAdapterReturn(uint256 reported, uint256 received);
    error DirectEthDisabled();

    bytes32[10] private _tickers = [
        bytes32("NVDA"), bytes32("TSLA"), bytes32("AAPL"), bytes32("AMZN"), bytes32("META"),
        bytes32("MSFT"), bytes32("GOOGL"), bytes32("NFLX"), bytes32("COIN"), bytes32("AMD")
    ];

    ITradingFeeSourceV6 public feeSource;
    StockRewardsV6 public immutable rewards;
    address public executor;
    uint256 public unallocatedEth;
    mapping(bytes32 ticker => address adapter) public swapAdapter;
    mapping(bytes32 ticker => uint256 amount) public tickerEth;
    uint256 public totalEthPulled;
    uint256 public totalEthSpent;
    mapping(bytes32 => uint256[]) private _pendingBatches;
    mapping(bytes32 => uint256) public nextBatch;

    event ExecutorChanged(address indexed executor);
    event FeeSourceConfigured(address indexed feeSource);
    event RouteConfigured(bytes32 indexed ticker, address indexed stockToken, address indexed adapter);
    event TradingFeesAllocated(uint256 pulled, uint256 allocated, uint256 unallocated);
    event StockPurchased(bytes32 indexed ticker, address indexed stockToken, uint256 ethSpent, uint256 tokenReceived);

    constructor(address initialOwner, address executor_, address rewards_) Ownable(initialOwner) {
        if (initialOwner == address(0) || executor_ == address(0) || rewards_ == address(0)) {
            revert InvalidAddress();
        }
        executor = executor_;
        rewards = StockRewardsV6(rewards_);
    }

    function configureFeeSource(address feeSource_) external onlyOwner {
        if (feeSource_.code.length == 0) revert InvalidAddress();
        if (address(feeSource) != address(0)) revert AlreadyConfigured();
        feeSource = ITradingFeeSourceV6(feeSource_);
        emit FeeSourceConfigured(feeSource_);
    }

    function setExecutor(address executor_) external onlyOwner {
        if (executor_ == address(0)) revert InvalidAddress();
        executor = executor_;
        emit ExecutorChanged(executor_);
    }

    function configureRoute(bytes32 ticker, address adapter) external onlyOwner {
        IERC20 token = rewards.stockToken(ticker);
        if (address(token) == address(0)) revert UnsupportedTicker(ticker);
        if (adapter.code.length == 0) revert InvalidAddress();
        swapAdapter[ticker] = adapter;
        token.forceApprove(address(rewards), type(uint256).max);
        emit RouteConfigured(ticker, address(token), adapter);
    }

    /// @notice Permissionless pulling is safe: allocation is derived only from on-chain Lit weights.
    function pullAndAllocateTradingFees() external nonReentrant returns (uint256 pulled) {
        return _pullAndAllocate();
    }

    function checkpointTradingFees() external nonReentrant {
        require(msg.sender == address(rewards), "Only rewards");
        if (address(feeSource) != address(0)) _pullAndAllocate();
    }

    function _pullAndAllocate() internal returns (uint256 pulled) {
        if (address(feeSource) == address(0)) revert InvalidAddress();
        uint256 balanceBefore = address(this).balance;
        feeSource.claimBucket();
        pulled = address(this).balance - balanceBefore;
        totalEthPulled += pulled;
        uint256 funds = pulled + unallocatedEth;

        uint256 combinedWeight;
        for (uint256 i; i < _tickers.length; ++i) combinedWeight += rewards.totalWeight(_tickers[i]);
        if (combinedWeight == 0) {
            unallocatedEth = funds;
            emit TradingFeesAllocated(pulled, 0, funds);
            return pulled;
        }

        uint256 allocated;
        bytes32 lastEligible;
        for (uint256 i; i < _tickers.length; ++i) {
            bytes32 ticker = _tickers[i];
            uint256 weight = rewards.totalWeight(ticker);
            if (weight == 0) continue;
            lastEligible = ticker;
            uint256 share = funds * weight / combinedWeight;
            tickerEth[ticker] += share;
            allocated += share;
        }
        uint256 remainder = funds - allocated;
        tickerEth[lastEligible] += remainder;
        allocated += remainder;
        unallocatedEth = 0;
        for (uint256 i; i < _tickers.length; ++i) {
            bytes32 ticker = _tickers[i];
            uint256 amount = tickerEth[ticker];
            if (amount == 0) continue;
            tickerEth[ticker] = 0;
            uint256 id = rewards.queueReward{value: amount}(ticker);
            _pendingBatches[ticker].push(id);
        }
        emit TradingFeesAllocated(pulled, allocated, 0);
    }

    function buyStock(bytes32 ticker, uint256 minAmountOut, uint256 deadline, bytes calldata routeData)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != executor) revert OnlyExecutor();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        address adapter = swapAdapter[ticker];
        IERC20 token = rewards.stockToken(ticker);
        if (adapter == address(0) || address(token) == address(0)) revert UnsupportedTicker(ticker);
        uint256 cursor = nextBatch[ticker];
        while (cursor < _pendingBatches[ticker].length) {
            (,,, uint256 funds,,,, bool converted) = rewards.batches(_pendingBatches[ticker][cursor]);
            if (!converted && funds != 0) break;
            ++cursor;
        }
        nextBatch[ticker] = cursor;
        if (cursor == _pendingBatches[ticker].length) revert NoAllocation(ticker);
        uint256 id = _pendingBatches[ticker][cursor];
        amountOut = _buyBatch(id, ticker, adapter, minAmountOut, deadline, routeData);
        if (amountOut != 0) nextBatch[ticker] = cursor + 1;
    }

    function buyBatch(uint256 id, uint256 minimum, uint256 deadline, bytes calldata data)
        external nonReentrant returns (uint256)
    {
        if (msg.sender != executor) revert OnlyExecutor();
        (bytes32 ticker,,,,,,,) = rewards.batches(id);
        address adapter = swapAdapter[ticker];
        if (adapter == address(0)) revert UnsupportedTicker(ticker);
        return _buyBatch(id, ticker, adapter, minimum, deadline, data);
    }

    function _buyBatch(uint256 id, bytes32 ticker, address adapter, uint256 minimum, uint256 deadline, bytes calldata data)
        internal returns (uint256 amount)
    {
        (,,, uint256 ethAmount,,,,) = rewards.batches(id);
        amount = rewards.convertBatch(id, adapter, minimum, deadline, data);
        if (amount != 0) {
            totalEthSpent += ethAmount;
            emit StockPurchased(ticker, address(rewards.stockToken(ticker)), ethAmount, amount);
        }
    }

    function tickers() external view returns (bytes32[10] memory) {
        return _tickers;
    }

    receive() external payable {
        if (msg.sender != address(feeSource)) revert DirectEthDisabled();
    }
}
