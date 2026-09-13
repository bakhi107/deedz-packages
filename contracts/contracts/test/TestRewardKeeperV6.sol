// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ITestStockBuyerKeeperV6 {
    function pullAndAllocateTradingFees() external returns (uint256);
    function buyStock(bytes32 ticker, uint256 minAmountOut, uint256 deadline, bytes calldata routeData)
        external returns (uint256);
}

/// @notice Testnet-only permissionless three-hour reward-cycle coordinator.
/// Production uses an external keeper with reviewed price quotes and slippage bounds.
contract TestRewardKeeperV6 {
    uint256 public constant INTERVAL = 3 hours;
    ITestStockBuyerKeeperV6 public immutable buyer;
    uint256 public lastRunAt;
    bytes32[10] private _tickers = [
        bytes32("NVDA"), bytes32("TSLA"), bytes32("AAPL"), bytes32("AMZN"), bytes32("META"),
        bytes32("MSFT"), bytes32("GOOGL"), bytes32("NFLX"), bytes32("COIN"), bytes32("AMD")
    ];

    event CycleRun(uint256 indexed timestamp, uint256 pulled, uint256 convertedClans);

    constructor(address buyer_) {
        require(buyer_.code.length != 0, "Buyer required");
        buyer = ITestStockBuyerKeeperV6(buyer_);
    }

    function nextRunAt() external view returns (uint256) {
        return lastRunAt == 0 ? 0 : lastRunAt + INTERVAL;
    }

    function runCycle() external returns (uint256 pulled, uint256 convertedClans) {
        require(lastRunAt == 0 || block.timestamp >= lastRunAt + INTERVAL, "Cycle not ready");
        lastRunAt = block.timestamp;
        pulled = buyer.pullAndAllocateTradingFees();
        for (uint256 i; i < _tickers.length; ++i) {
            try buyer.buyStock(_tickers[i], 1, block.timestamp + 5 minutes, "") returns (uint256 amount) {
                if (amount != 0) ++convertedClans;
            } catch { /* A clan with no pending allocation does not block the cycle. */ }
        }
        emit CycleRun(block.timestamp, pulled, convertedClans);
    }
}
