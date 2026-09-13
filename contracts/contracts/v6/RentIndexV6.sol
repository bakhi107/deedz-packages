// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Prospective ETH-per-USD rent index. Observations never reprice history.
/// A keeper observes new rounds; an expired observation accrues nothing until observed again.
contract RentIndexV6 {
    uint256 public constant SCALE = 1e27;
    uint256 public constant MAX_AGE = 1 days;
    struct Checkpoint { uint64 at; uint64 expires; uint256 index; uint256 slope; uint256 uptime; }
    IPriceOracle public immutable oracle;
    Checkpoint[] public checkpoints;
    uint256 public observedRound;
    event Observed(uint256 indexed checkpoint, uint256 priceUsd6, uint256 feedTimestamp);

    constructor(address feed) {
        oracle = IPriceOracle(feed);
        checkpoints.push(Checkpoint(uint64(block.timestamp), uint64(block.timestamp), 0, 0, 0));
        sync();
    }

    function sync() public {
        try oracle.latestPriceUsd6() returns (uint256 price, uint256 timestamp) {
            if (price == 0 || timestamp > block.timestamp || timestamp + MAX_AGE <= block.timestamp
                || timestamp <= observedRound) return;
            uint256 current = indexAt(block.timestamp);
            observedRound = timestamp;
            checkpoints.push(Checkpoint(uint64(block.timestamp), uint64(timestamp + MAX_AGE), current,
                1 ether * 30 * SCALE / price / 10_000 / 1 days, activeSecondsAt(block.timestamp)));
            emit Observed(checkpoints.length - 1, price, timestamp);
        } catch { /* Fail closed: the last observation expires without back-billing. */ }
    }

    function indexAt(uint256 timestamp) public view returns (uint256) {
        if (timestamp < checkpoints[0].at) return 0;
        uint256 lo;
        uint256 hi = checkpoints.length;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            if (checkpoints[mid].at <= timestamp) lo = mid; else hi = mid;
        }
        Checkpoint memory point = checkpoints[lo];
        uint256 end = timestamp < point.expires ? timestamp : point.expires;
        return point.index + (end > point.at ? end - point.at : 0) * point.slope;
    }

    function count() external view returns (uint256) { return checkpoints.length; }

    function activeSecondsAt(uint256 timestamp) public view returns (uint256) {
        if (timestamp < checkpoints[0].at) return 0;
        uint256 lo;
        uint256 hi = checkpoints.length;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            if (checkpoints[mid].at <= timestamp) lo = mid; else hi = mid;
        }
        Checkpoint memory point = checkpoints[lo];
        uint256 end = timestamp < point.expires ? timestamp : point.expires;
        return point.uptime + (end > point.at ? end - point.at : 0);
    }
}
