// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ITickerRegistry} from "./interfaces/ITickerRegistry.sol";

/// @title FloorManager
/// @notice Derives bounded Deed floors from each ticker's trailing seven-day fees.
contract FloorManager is Ownable {
    uint256 public constant MIN_FLOOR_USD6 = 5e6;
    uint256 public constant DAILY_TAX_BPS = 30;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant DAY = 86_400;
    uint256 public constant WINDOW_DAYS = 7;
    uint256 public constant LAMBDA_START_BPS = 1_000;
    uint256 public constant LAMBDA_END_BPS = 5_000;
    uint256 public constant LAMBDA_RAMP_DAYS = 90;

    error InvalidAddress();
    error UnauthorizedReporter(address caller);
    error InvalidAmount();

    struct FloorState {
        uint128 floorUsd6;
        uint64 lastIncreaseAt;
        uint64 lastRaisedAt;
    }

    ITickerRegistry public immutable registry;
    uint64 public immutable launchedAt;
    address public feeReporter;

    mapping(bytes32 ticker => mapping(uint256 day => uint256 feesUsd6)) public dailyFeesUsd6;
    mapping(bytes32 ticker => FloorState state) private _floors;

    event FeeReporterSet(address indexed reporter);
    event FeeRecorded(bytes32 indexed ticker, uint256 indexed day, uint256 feeUsd6);
    event FloorMoved(bytes32 indexed ticker, uint256 oldFloorUsd6, uint256 newFloorUsd6);

    constructor(address initialOwner, address registry_, address feeReporter_, uint64 launchedAt_) Ownable(initialOwner) {
        if (initialOwner == address(0) || registry_ == address(0) || feeReporter_ == address(0)) revert InvalidAddress();
        registry = ITickerRegistry(registry_);
        feeReporter = feeReporter_;
        launchedAt = launchedAt_ == 0 ? uint64(block.timestamp) : launchedAt_;
    }

    function setFeeReporter(address reporter) external onlyOwner {
        if (reporter == address(0)) revert InvalidAddress();
        feeReporter = reporter;
        emit FeeReporterSet(reporter);
    }

    function recordFee(bytes32 ticker, uint256 feeUsd6) external {
        if (msg.sender != feeReporter) revert UnauthorizedReporter(msg.sender);
        if (feeUsd6 == 0) revert InvalidAmount();
        registry.getTicker(ticker);
        uint256 day = block.timestamp / DAY;
        dailyFeesUsd6[ticker][day] += feeUsd6;
        emit FeeRecorded(ticker, day, feeUsd6);
    }

    function syncFloor(bytes32 ticker) external returns (uint256 newFloorUsd6) {
        FloorState storage state = _floors[ticker];
        uint256 oldFloorUsd6 = state.floorUsd6 == 0 ? MIN_FLOOR_USD6 : state.floorUsd6;
        uint256 lastIncreaseAt = state.lastIncreaseAt == 0 ? launchedAt : state.lastIncreaseAt;
        uint256 target = previewTarget(ticker);

        if (target > oldFloorUsd6) {
            uint256 elapsedDays = (block.timestamp - lastIncreaseAt) / DAY;
            if (elapsedDays == 0) return oldFloorUsd6;
            // Linear accumulation is deliberately stricter than compounding and never exceeds 10% for any day.
            uint256 riseCap = Math.mulDiv(oldFloorUsd6, 100 + 10 * elapsedDays, 100);
            newFloorUsd6 = Math.min(target, riseCap);
            state.lastIncreaseAt = uint64(lastIncreaseAt + elapsedDays * DAY);
        } else {
            newFloorUsd6 = target;
            state.lastIncreaseAt = uint64(block.timestamp);
        }

        state.floorUsd6 = uint128(newFloorUsd6);
        if (newFloorUsd6 > oldFloorUsd6) state.lastRaisedAt = uint64(block.timestamp);
        if (newFloorUsd6 != oldFloorUsd6) emit FloorMoved(ticker, oldFloorUsd6, newFloorUsd6);
    }

    function floorOf(bytes32 ticker) external view returns (uint256) {
        uint256 floorUsd6 = _floors[ticker].floorUsd6;
        return floorUsd6 == 0 ? MIN_FLOOR_USD6 : floorUsd6;
    }

    function lastRaisedAt(bytes32 ticker) external view returns (uint256) {
        return _floors[ticker].lastRaisedAt;
    }

    function previewTarget(bytes32 ticker) public view returns (uint256) {
        ITickerRegistry.TickerConfig memory config = registry.getTicker(ticker);
        uint256 feesUsd6 = trailingFeesUsd6(ticker);
        uint256 averageFeesPerDeedPerDay = feesUsd6 / config.deedSupply / WINDOW_DAYS;
        uint256 breakEvenUsd6 = Math.mulDiv(averageFeesPerDeedPerDay, BPS_DENOMINATOR, DAILY_TAX_BPS);
        uint256 economicFloor = Math.mulDiv(breakEvenUsd6, lambdaBps(), BPS_DENOMINATOR);
        return Math.max(MIN_FLOOR_USD6, economicFloor);
    }

    function trailingFeesUsd6(bytes32 ticker) public view returns (uint256 total) {
        uint256 currentDay = block.timestamp / DAY;
        for (uint256 offset; offset < WINDOW_DAYS; ++offset) {
            total += dailyFeesUsd6[ticker][currentDay - offset];
        }
    }

    function lambdaBps() public view returns (uint256) {
        uint256 daysSinceLaunch = (block.timestamp - launchedAt) / DAY;
        if (daysSinceLaunch >= LAMBDA_RAMP_DAYS) return LAMBDA_END_BPS;
        return LAMBDA_START_BPS
            + Math.mulDiv(LAMBDA_END_BPS - LAMBDA_START_BPS, daysSinceLaunch, LAMBDA_RAMP_DAYS);
    }
}
