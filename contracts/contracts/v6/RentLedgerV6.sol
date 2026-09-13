// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Permanent address rent history and bounded full clan rankings. No holder-size shortcut.
contract RentLedgerV6 is Ownable {
    uint256 public immutable epoch;
    address public vault;
    mapping(address => uint256) public lifetimeRentUsd6;
    mapping(uint256 => uint256) public weeklyTotal;
    mapping(uint256 => mapping(address => uint256)) public weeklyRent;
    mapping(uint256 => mapping(bytes32 => uint256)) public clanRent;
    mapping(uint256 => mapping(bytes32 => uint256)) public reachedAt;
    mapping(uint256 => bool) public sealedWeek;
    uint256 public cumulativeRentUsd6;
    uint256 public sequence;
    mapping(uint256 => mapping(bytes32 => uint256)) public reachedSequence;
    bytes32[10] public tickers = [bytes32("NVDA"), "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "NFLX", "COIN", "AMD"];
    event RentRecorded(uint256 indexed week, bytes32 indexed ticker, address indexed holder, uint256 usd6, uint256 paidAt);
    event WeekSealed(uint256 indexed week, bytes32 winner, uint256 totalUsd6);
    constructor(address governor, uint256 launch) Ownable(governor) { epoch = launch - (launch + 4 days) % 7 days; }
    function configureVault(address value) external onlyOwner {
        require(vault == address(0) && value.code.length != 0, "Invalid vault"); vault = value;
    }
    function weekOf(uint256 timestamp) public view returns (uint256) { return (timestamp - epoch) / 7 days; }
    function weekEnd(uint256 week) public view returns (uint256) { return epoch + (week + 1) * 7 days; }
    function record(bytes32 ticker, address holder, uint256 usd6, uint256 paidAt) external {
        require(msg.sender == vault, "Only vault");
        uint256 week = weekOf(paidAt - 1);
        require(!sealedWeek[week], "Week sealed");
        if (usd6 == 0) return;
        lifetimeRentUsd6[holder] += usd6;
        weeklyRent[week][holder] += usd6;
        weeklyTotal[week] += usd6;
        cumulativeRentUsd6 += usd6;
        clanRent[week][ticker] += usd6;
        if (paidAt > reachedAt[week][ticker]) reachedAt[week][ticker] = paidAt;
        reachedSequence[week][ticker] = ++sequence;
        emit RentRecorded(week, ticker, holder, usd6, paidAt);
    }
    function seal(uint256 week) external {
        require(msg.sender == vault && block.timestamp >= weekEnd(week), "Cannot seal");
        require(!sealedWeek[week], "Already sealed");
        sealedWeek[week] = true;
        bytes32[10] memory order = ranking(week);
        emit WeekSealed(week, weeklyTotal[week] == 0 ? bytes32(0) : order[0], weeklyTotal[week]);
    }
    function ranking(uint256 week) public view returns (bytes32[10] memory order) {
        order = tickers;
        for (uint256 i = 1; i < 10; ++i) {
            bytes32 value = order[i]; uint256 j = i;
            while (j > 0 && _before(week, value, order[j - 1])) { order[j] = order[j - 1]; --j; }
            order[j] = value;
        }
    }
    function _before(uint256 week, bytes32 a, bytes32 b) private view returns (bool) {
        uint256 av = clanRent[week][a]; uint256 bv = clanRent[week][b];
        return av > bv || (av == bv && (reachedAt[week][a] < reachedAt[week][b]
            || (reachedAt[week][a] == reachedAt[week][b] && reachedSequence[week][a] < reachedSequence[week][b])));
    }
}
