// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentFeeRouterV6} from "./RentFeeRouterV6.sol";
import {RentVaultV6} from "./RentVaultV6.sol";

/// @notice Disconnected phase-two revenue locker. Revenue must be explicitly funded;
/// this module cannot take any of the launch holder, LP, jackpot or Throne allocations.
contract RevenueLockerV6 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Lock { uint256 amount; uint256 debt; uint256 credit; uint64 until; }
    IERC20 public immutable rent;
    uint256 public immutable opensAt;
    bool public enabled;
    address public revenueSource;
    uint256 public totalLocked;
    uint256 public rewardPerToken;
    uint256 public pending;
    uint256 private rewardCarry;
    mapping(address => Lock) public locks;
    event Locked(address indexed holder, uint256 amount, uint256 until);
    event RevenueFunded(uint256 grossRevenue, uint256 lockerShare);
    constructor(address governor, address rent_, uint256 launch) Ownable(governor) { rent = IERC20(rent_); opensAt = launch + 30 days; }
    function configure(bool enabled_, address source) external onlyOwner {
        require(!enabled_ || (block.timestamp >= opensAt && source.code.length != 0), "Phase two unavailable");
        enabled = enabled_; revenueSource = source;
    }
    function lock(uint256 amount, uint64 until) external nonReentrant {
        require(enabled && amount != 0 && until >= block.timestamp + 7 days && until <= block.timestamp + 365 days, "Invalid lock");
        _settle(msg.sender); Lock storage l = locks[msg.sender];
        require(until >= l.until, "Cannot shorten lock");
        uint256 beforeBalance = rent.balanceOf(address(this));
        rent.safeTransferFrom(msg.sender, address(this), amount);
        require(rent.balanceOf(address(this)) - beforeBalance == amount, "Inexact RENT");
        l.amount += amount; totalLocked += amount; l.until = until;
        l.debt = l.amount * rewardPerToken / 1e27;
        emit Locked(msg.sender, amount, until);
    }
    function notifyRevenue(uint256 grossRevenue) external payable {
        require(enabled && msg.sender == revenueSource && msg.value == grossRevenue * 30 / 100, "Fund the full thirty percent");
        uint256 amount = pending + msg.value;
        if (totalLocked == 0) pending = amount;
        else { uint256 numerator = amount * 1e27 + rewardCarry; rewardPerToken += numerator / totalLocked; rewardCarry = numerator % totalLocked; pending = 0; }
        emit RevenueFunded(grossRevenue, msg.value);
    }
    function unlock() external nonReentrant {
        _settle(msg.sender); Lock storage l = locks[msg.sender];
        require(block.timestamp >= l.until, "Still locked"); uint256 amount = l.amount;
        l.amount = 0; l.debt = 0; totalLocked -= amount; rent.safeTransfer(msg.sender, amount);
    }
    function claim(address payable recipient) external nonReentrant {
        require(recipient != address(0), "Invalid recipient"); _settle(msg.sender);
        uint256 amount = locks[msg.sender].credit; locks[msg.sender].credit = 0;
        (bool ok,) = recipient.call{value: amount}(""); require(ok, "Claim failed");
    }
    function _settle(address holder) private {
        Lock storage l = locks[holder]; uint256 accrued = l.amount * rewardPerToken / 1e27;
        l.credit += accrued - l.debt; l.debt = accrued;
    }
}

/// @notice The 10% rent discount is funded by a separate ETH subsidy reserve.
/// RENT sale proceeds cover 90% of the resulting ETH deposit; no principal is diverted.
contract RentDiscountV6 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    RentFeeRouterV6 public immutable router;
    RentVaultV6 public immutable vault;
    uint256 public immutable opensAt;
    bool public enabled;
    uint256 public subsidySpent;
    constructor(address governor, address router_, address vault_, uint256 launch) Ownable(governor) {
        router = RentFeeRouterV6(payable(router_)); vault = RentVaultV6(payable(vault_)); opensAt = launch + 30 days;
    }
    function setEnabled(bool value) external onlyOwner { require(!value || block.timestamp >= opensAt, "Phase two only"); enabled = value; }
    function recoverUnusedSubsidy() external { vault.claimRefund(payable(address(this))); }
    function payRent(uint256 id, uint256 rentAmount, uint256 minEthOut, uint256 deadline) external nonReentrant {
        require(enabled && rentAmount != 0 && minEthOut != 0 && deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "Invalid payment");
        uint256 reserve = address(this).balance;
        IERC20 rent = IERC20(address(router.rent()));
        uint256 beforeBalance = rent.balanceOf(address(this)); rent.safeTransferFrom(msg.sender, address(this), rentAmount);
        require(rent.balanceOf(address(this)) - beforeBalance == rentAmount, "Inexact RENT");
        rent.forceApprove(address(router), rentAmount);
        uint256 received = router.swapExactInputRentForEth(rentAmount, minEthOut, deadline);
        rent.forceApprove(address(router), 0);
        uint256 subsidy = received / 9;
        require(reserve >= subsidy, "Subsidy exhausted"); subsidySpent += subsidy;
        vault.sponsorTopUp{value: received + subsidy}(id, subsidy);
    }
    receive() external payable {}
}
