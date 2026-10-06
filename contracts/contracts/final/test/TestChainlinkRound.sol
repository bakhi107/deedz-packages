// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Local tests only: permits malformed/stale answers to exercise fail-closed behavior.
contract TestChainlinkRound {
    uint8 public immutable decimals;
    uint80 private _round;
    int256 private _answer;
    uint256 private _started;
    uint256 private _updated;
    uint80 private _answered;
    bool public unavailable;

    constructor(uint8 decimals_) { decimals = decimals_; }
    function setRound(uint80 round, int256 answer, uint256 started, uint256 updated, uint80 answered) external {
        _round = round; _answer = answer; _started = started; _updated = updated; _answered = answered;
    }
    function setUnavailable(bool value) external { unavailable = value; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!unavailable, "Feed unavailable");
        return (_round, _answer, _started, _updated, _answered);
    }
}
