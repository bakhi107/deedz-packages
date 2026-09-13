// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentVaultV6} from "./RentVaultV6.sol";
import {RentLedgerV6} from "./RentLedgerV6.sol";
import {StockRewardsV6} from "./StockRewardsV6.sol";

contract JackpotV6 is ReentrancyGuard {
    RentVaultV6 public immutable vault;
    RentLedgerV6 public immutable ledger;
    StockRewardsV6 public immutable rewards;
    uint256 public nextWeek;
    uint256 public rollover;
    event WeekPaid(uint256 indexed week, bytes32 indexed winner, uint256 amount, uint256 batch);
    event RolledOver(uint256 indexed week, uint256 amount);
    constructor(address vault_, address ledger_, address rewards_) {
        vault = RentVaultV6(payable(vault_)); ledger = RentLedgerV6(ledger_); rewards = StockRewardsV6(rewards_);
    }
    function settleWeek() external nonReentrant {
        uint256 week = nextWeek;
        require(ledger.sealedWeek(week), "Week not settled");
        ++nextWeek;
        uint256 funds = vault.claimWeeklyJackpot(week) + rollover;
        uint256 snapshot = rewards.versionBefore(ledger.weekEnd(week));
        bytes32[10] memory order = ledger.ranking(week);
        if (ledger.weeklyTotal(week) == 0 || rewards.totalWeightAt(order[0], snapshot) == 0 || funds == 0) {
            rollover = funds;
            emit RolledOver(week, funds);
        } else {
            rollover = 0;
            uint256 batch = rewards.queueSnapshotReward{value: funds}(order[0], snapshot);
            emit WeekPaid(week, order[0], funds, batch);
        }
    }
    receive() external payable { require(msg.sender == address(vault), "Only vault"); }
}
