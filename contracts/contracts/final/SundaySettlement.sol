// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentTreasury} from "./RentTreasury.sol";
import {StockRewards} from "./StockRewards.sol";
import {IStockSwap} from "./interfaces/IStockSwap.sol";

interface IBurnableToken is IERC20 { function burn(uint256 amount) external; }

/// @notice Executes each finalized Sunday's required 50/25/20/5 rent split.
contract SundaySettlement is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    RentTreasury public immutable treasury;
    StockRewards public immutable rewards;
    IBurnableToken public immutable rent;
    IStockSwap public exchange;
    address public keeper;
    address payable public liquidity;
    address payable public team;
    mapping(uint256 => bool) public settled;

    event WeekSettled(uint256 indexed week, bytes32 indexed winner, uint256 totalEth, uint256 rentBurned, uint256 jackpotStock);

    constructor(address owner_, address keeper_, address treasury_, address rewards_, address rent_, address exchange_, address payable liquidity_, address payable team_)
        Ownable(owner_)
    {
        require(keeper_ != address(0) && treasury_.code.length != 0 && rewards_.code.length != 0 && rent_.code.length != 0 && exchange_.code.length != 0 && liquidity_ != address(0) && team_ != address(0), "Invalid configuration");
        keeper = keeper_; treasury = RentTreasury(payable(treasury_)); rewards = StockRewards(rewards_);
        rent = IBurnableToken(rent_); exchange = IStockSwap(exchange_); liquidity = liquidity_; team = team_;
    }

    modifier onlyKeeper() { require(msg.sender == keeper, "Only keeper"); _; }
    receive() external payable { require(msg.sender == address(treasury), "Only treasury"); }
    function setKeeper(address value) external onlyOwner { require(value != address(0), "Invalid keeper"); keeper = value; }
    function setLiquidity(address payable value) external onlyOwner { require(value != address(0), "Invalid liquidity"); liquidity = value; }

    function winningClan(uint256 week) public view returns (bytes32 winner, uint256 score) {
        for (uint256 i; i < 10; ++i) {
            bytes32 ticker = treasury.tickers(i); uint256 candidate = treasury.clanScoreUsd6(week, ticker);
            if (candidate > score) { winner = ticker; score = candidate; }
        }
    }

    function settle(uint256 week, uint256 minimumRentOut, uint256 minimumStockOut, bytes32 jackpotRoot) external onlyKeeper nonReentrant {
        require(!settled[week] && jackpotRoot != bytes32(0), "Invalid settlement"); settled[week] = true;
        uint256 total = treasury.releaseWeek(week); require(total != 0, "No rent");
        uint256 burnEth = total * 50 / 100; uint256 liquidityEth = total * 25 / 100;
        uint256 jackpotEth = total * 20 / 100; uint256 teamEth = total - burnEth - liquidityEth - jackpotEth;
        uint256 rentOut = exchange.buyRent{value: burnEth}(address(this), minimumRentOut); rent.burn(rentOut);
        (bool lpOk,) = liquidity.call{value: liquidityEth}(""); require(lpOk, "Liquidity transfer failed");
        (bytes32 winner,) = winningClan(week); require(winner != bytes32(0), "No winning clan");
        IERC20 stock = rewards.stockToken(winner); require(address(stock) != address(0), "Winner token missing");
        uint256 stockOut = exchange.buyStock{value: jackpotEth}(winner, address(this), minimumStockOut);
        stock.forceApprove(address(rewards), stockOut); rewards.createBatch(winner, jackpotRoot, stockOut); stock.forceApprove(address(rewards), 0);
        (bool teamOk,) = team.call{value: teamEth}(""); require(teamOk, "Team transfer failed");
        emit WeekSettled(week, winner, total, rentOut, stockOut);
    }
}
