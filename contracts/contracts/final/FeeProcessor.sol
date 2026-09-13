// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StockRewards} from "./StockRewards.sol";
import {IStockSwap} from "./interfaces/IStockSwap.sol";

contract FeeProcessor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant INTERVAL = 3 hours;
    struct Allocation { bytes32 ticker; uint256 ethAmount; uint256 minimumStockOut; bytes32 merkleRoot; }

    StockRewards public immutable rewards;
    IStockSwap public exchange;
    address public keeper;
    address payable public liquidity;
    address payable public team;
    uint256 public queuedTradingFees;
    uint256 public teamBalance;
    uint64 public lastCycleAt;
    mapping(address => bool) public feeSource;

    event TradingFeeQueued(address indexed source, uint256 amount);
    event CycleProcessed(uint256 indexed timestamp, uint256 fees, uint256 rewardsEth, uint256 liquidityEth, uint256 teamEth);
    event SaleFeeReceived(uint256 amount);

    constructor(address owner_, address keeper_, address rewards_, address exchange_, address payable liquidity_, address payable team_)
        Ownable(owner_)
    {
        require(keeper_ != address(0) && rewards_.code.length != 0 && exchange_.code.length != 0 && liquidity_ != address(0) && team_ != address(0), "Invalid configuration");
        keeper = keeper_; rewards = StockRewards(rewards_); exchange = IStockSwap(exchange_); liquidity = liquidity_; team = team_;
        lastCycleAt = uint64(block.timestamp);
    }

    modifier onlyKeeper() { require(msg.sender == keeper, "Only keeper"); _; }

    function setFeeSource(address source, bool allowed) external onlyOwner { require(source != address(0), "Invalid source"); feeSource[source] = allowed; }
    function setKeeper(address value) external onlyOwner { require(value != address(0), "Invalid keeper"); keeper = value; }
    function setExchange(address value) external onlyOwner { require(value.code.length != 0, "Invalid exchange"); exchange = IStockSwap(value); }
    function setLiquidity(address payable value) external onlyOwner { require(value != address(0), "Invalid liquidity"); liquidity = value; }

    function depositTradingFees() external payable {
        require(feeSource[msg.sender] && msg.value != 0, "Unauthorized fee source");
        queuedTradingFees += msg.value; emit TradingFeeQueued(msg.sender, msg.value);
    }

    function depositSaleFee() external payable {
        require(feeSource[msg.sender] && msg.value != 0, "Unauthorized fee source");
        teamBalance += msg.value; emit SaleFeeReceived(msg.value);
    }

    function processCycle(Allocation[] calldata allocations) external onlyKeeper nonReentrant {
        require(block.timestamp >= uint256(lastCycleAt) + INTERVAL, "Cycle not ready");
        uint256 fees = queuedTradingFees; require(fees != 0, "No fees queued");
        uint256 rewardsEth = fees * 70 / 100; uint256 liquidityEth = fees * 20 / 100; uint256 teamEth = fees - rewardsEth - liquidityEth;
        uint256 allocated; queuedTradingFees = 0; lastCycleAt = uint64(block.timestamp); teamBalance += teamEth;
        for (uint256 i; i < allocations.length; ++i) {
            Allocation calldata a = allocations[i]; require(a.ethAmount != 0 && a.merkleRoot != bytes32(0), "Invalid allocation");
            allocated += a.ethAmount;
            IERC20 token = rewards.stockToken(a.ticker); require(address(token) != address(0), "Unknown stock");
            uint256 amount = exchange.buyStock{value: a.ethAmount}(a.ticker, address(this), a.minimumStockOut);
            token.forceApprove(address(rewards), amount); rewards.createBatch(a.ticker, a.merkleRoot, amount); token.forceApprove(address(rewards), 0);
        }
        require(allocated == rewardsEth, "Allocation mismatch");
        (bool ok,) = liquidity.call{value: liquidityEth}(""); require(ok, "Liquidity transfer failed");
        emit CycleProcessed(block.timestamp, fees, rewardsEth, liquidityEth, teamEth);
    }

    function claimTeam(address payable recipient) external nonReentrant returns (uint256 amount) {
        require(msg.sender == team && recipient != address(0), "Only team"); amount = teamBalance; teamBalance = 0;
        (bool ok,) = recipient.call{value: amount}(""); require(ok, "Transfer failed");
    }
}
