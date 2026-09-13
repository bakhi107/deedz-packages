// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentTokenV6} from "./RentTokenV6.sol";
import {RentLedgerV6} from "./RentLedgerV6.sol";

contract RentVestingV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    address public immutable beneficiary;
    uint256 public immutable cliff;
    uint256 public immutable duration;
    uint256 public immutable allocation;
    uint256 public released;
    constructor(address token_, address recipient, uint256 launch, uint256 yearsLinear, uint256 amount) {
        require(recipient != address(0), "Invalid beneficiary");
        token = IERC20(token_); beneficiary = recipient; cliff = launch + 365 days;
        duration = yearsLinear * 365 days; allocation = amount;
    }
    function vested() public view returns (uint256) {
        if (block.timestamp <= cliff) return 0;
        uint256 elapsed = block.timestamp - cliff;
        return elapsed >= duration ? allocation : allocation * elapsed / duration;
    }
    function release() external nonReentrant returns (uint256 amount) {
        amount = vested() - released; released += amount;
        token.safeTransfer(beneficiary, amount);
    }
}

contract RentEmitterV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant ALLOCATION = 400_000_000 ether;
    uint256 public constant INITIAL_K = 100 ether; // RENT per USD
    IERC20 public immutable token;
    RentLedgerV6 public immutable ledger;
    uint256 public immutable firstClaimAt;
    uint256 public nextWeek;
    uint256 public cumulativeRent;
    uint256 public allocated;
    mapping(uint256 => uint256) public weeklyEmission;
    mapping(uint256 => uint256) public remainingRent;
    mapping(uint256 => uint256) public remainingEmission;
    mapping(uint256 => mapping(address => bool)) public claimed;
    event EmissionFinalized(uint256 indexed week, uint256 rentUsd6, uint256 tokens);
    constructor(address token_, address ledger_, uint256 launch) {
        token = IERC20(token_); ledger = RentLedgerV6(ledger_); firstClaimAt = launch + 14 days;
    }
    function finalizeWeek() external {
        uint256 week = nextWeek;
        require(ledger.sealedWeek(week), "Unsettled rent");
        uint256 usd6 = ledger.weeklyTotal(week);
        uint256 amount = emission(cumulativeRent, usd6);
        if (amount > ALLOCATION - allocated) amount = ALLOCATION - allocated;
        cumulativeRent += usd6; allocated += amount;
        weeklyEmission[week] = amount; ++nextWeek;
        remainingRent[week] = usd6; remainingEmission[week] = amount;
        emit EmissionFinalized(week, usd6, amount);
    }
    function emission(uint256 prior, uint256 usd6) public pure returns (uint256 amount) {
        uint256 boundary = 1_000_000 * 1e6;
        uint256 k = INITIAL_K;
        while (prior >= boundary && k != 0) { boundary *= 2; k /= 2; }
        while (usd6 != 0 && k != 0) {
            uint256 part = usd6 < boundary - prior ? usd6 : boundary - prior;
            amount += part * k / 1e6;
            prior += part; usd6 -= part;
            if (prior == boundary) { boundary *= 2; k /= 2; }
        }
    }
    function claim(uint256 week, address recipient) external nonReentrant returns (uint256 amount) {
        require(block.timestamp >= firstClaimAt && week < nextWeek && !claimed[week][msg.sender], "Unavailable emission");
        require(recipient != address(0), "Invalid recipient");
        claimed[week][msg.sender] = true;
        uint256 total = remainingRent[week];
        uint256 paid = ledger.weeklyRent(week, msg.sender);
        amount = total == 0 ? 0 : remainingEmission[week] * paid / total;
        remainingRent[week] -= paid; remainingEmission[week] -= amount;
        token.safeTransfer(recipient, amount);
    }
}

/// @notice Atomically allocates exactly one billion tokens, with no subsequent mint authority.
contract RentAllocationV6 {
    RentTokenV6 public immutable rent;
    RentEmitterV6 public immutable emitter;
    RentVestingV6 public immutable teamVesting;
    RentVestingV6 public immutable strategicVesting;
    constructor(address ledger, uint256 launch, address team, address treasury, address strategic,
        address liquidity, address fairLaunch, address insurance) {
        require(treasury != address(0) && liquidity.code.length != 0 && fairLaunch.code.length != 0 && insurance != address(0), "Invalid allocation");
        rent = new RentTokenV6(address(this));
        emitter = new RentEmitterV6(address(rent), ledger, launch);
        teamVesting = new RentVestingV6(address(rent), team, launch, 3, 180_000_000 ether);
        strategicVesting = new RentVestingV6(address(rent), strategic, launch, 2, 100_000_000 ether);
        rent.transfer(address(emitter), 400_000_000 ether);
        rent.transfer(address(teamVesting), 180_000_000 ether);
        rent.transfer(treasury, 200_000_000 ether);
        rent.transfer(address(strategicVesting), 100_000_000 ether);
        rent.transfer(liquidity, 20_000_000 ether);
        rent.transfer(fairLaunch, 50_000_000 ether);
        rent.transfer(insurance, 50_000_000 ether);
    }
}
