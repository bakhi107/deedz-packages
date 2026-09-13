// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @notice Holds non-refundable rent, records deposits immediately for Clan Wars,
/// and recognizes the ETH for Sunday distribution only as runway time passes.
contract RentTreasury is Ownable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant DAILY_RENT_BPS = 30;
    uint256 public constant GRACE = 1 days;
    uint256 public constant MIN_RUNWAY = 7 days;
    uint256 public constant MAX_ORACLE_AGE = 1 days;

    struct Position {
        uint256 balance;
        uint256 priceUsd6;
        uint256 dailyWei;
        uint64 accountedAt;
        uint64 zeroAt;
        uint32 accrualRemainder;
        bool opened;
        bytes32 ticker;
        address holder;
    }

    IPriceFeed public immutable priceFeed;
    address public deed;
    address public keeper;
    address public settlement;
    address payable public team;
    uint64 public immutable epoch;
    bytes32[10] public tickers = [bytes32("NVDA"), "TSLA","AAPL","MSFT","AMZN","META","GOOGL","NFLX","AMD","PLTR"];

    mapping(uint256 => Position) private _position;
    uint256[] private _ids;
    mapping(uint256 => mapping(bytes32 => uint256)) public clanScoreUsd6;
    mapping(uint256 => mapping(address => uint256)) public holderScoreUsd6;
    mapping(address => uint256) public lifetimeScoreUsd6;
    mapping(uint256 => uint256) public distributableRentEth;
    mapping(uint256 => uint256) public checkpointCursor;
    mapping(uint256 => bool) public weekFinalized;
    uint256 public teamBalance;

    event DeedConfigured(address indexed deed);
    event KeeperUpdated(address indexed keeper);
    event SettlementConfigured(address indexed settlement);
    event RentCommitted(uint256 indexed tokenId, bytes32 indexed ticker, address indexed holder, uint256 ethAmount, uint256 usd6);
    event RentConsumed(uint256 indexed tokenId, uint256 indexed week, uint256 ethAmount);
    event PositionReplaced(uint256 indexed tokenId, address indexed oldHolder, address indexed newHolder, uint256 unusedToTeam);
    event WeekFinalized(uint256 indexed week, uint256 rentEth);

    modifier onlyDeed() { require(msg.sender == deed, "Only deed"); _; }
    modifier onlyKeeper() { require(msg.sender == keeper, "Only keeper"); _; }

    constructor(address owner_, address keeper_, address payable team_, address feed_) Ownable(owner_) {
        require(owner_ != address(0) && keeper_ != address(0) && team_ != address(0) && feed_.code.length != 0, "Invalid address");
        keeper = keeper_; team = team_; priceFeed = IPriceFeed(feed_);
        epoch = uint64(block.timestamp - (block.timestamp + 4 days) % 7 days);
    }

    function configureDeed(address value) external onlyOwner {
        require(deed == address(0) && value.code.length != 0, "Deed frozen"); deed = value; emit DeedConfigured(value);
    }
    function setKeeper(address value) external onlyOwner { require(value != address(0), "Invalid keeper"); keeper = value; emit KeeperUpdated(value); }
    function configureSettlement(address value) external onlyOwner {
        require(settlement == address(0) && value.code.length != 0, "Settlement frozen");
        settlement = value;
        emit SettlementConfigured(value);
    }

    function open(uint256 id, bytes32 ticker, address holder, uint256 priceUsd6) external payable onlyDeed {
        require(!_position[id].opened && _supported(ticker), "Invalid position");
        uint256 daily = dailyRentWei(priceUsd6);
        require(msg.value >= daily * 7, "Seven days required");
        _position[id] = Position(msg.value, priceUsd6, daily, uint64(block.timestamp), 0, 0, true, ticker, holder);
        _ids.push(id); _recordCommit(id, ticker, holder, msg.value);
    }

    function topUp(uint256 id, address holder) external payable onlyDeed {
        Position storage p = _require(id); _consumeTo(id, block.timestamp);
        require(p.holder == holder && msg.value != 0, "Invalid top up");
        if (p.balance == 0) { p.accountedAt = uint64(block.timestamp); p.accrualRemainder = 0; }
        p.balance += msg.value; p.zeroAt = 0; _recordCommit(id, p.ticker, holder, msg.value);
    }

    function reopen(uint256 id, bytes32 ticker, address holder, uint256 priceUsd6) external payable onlyDeed {
        Position storage p = _require(id); _consumeTo(id, block.timestamp);
        (,,uint256 graceEnd) = preview(id);
        require(block.timestamp >= graceEnd && p.balance == 0 && p.ticker == ticker, "Position not Dark");
        uint256 daily = dailyRentWei(priceUsd6);
        require(msg.value >= daily * 7, "Seven days required");
        p.balance = msg.value; p.priceUsd6 = priceUsd6; p.dailyWei = daily;
        p.accountedAt = uint64(block.timestamp); p.zeroAt = 0; p.accrualRemainder = 0; p.holder = holder;
        _recordCommit(id, ticker, holder, msg.value);
    }

    function setPrice(uint256 id, uint256 priceUsd6) external onlyDeed {
        Position storage p = _require(id); _consumeTo(id, block.timestamp);
        p.priceUsd6 = priceUsd6; p.dailyWei = dailyRentWei(priceUsd6);
    }

    function replace(uint256 id, address oldHolder, address newHolder, uint256 newPriceUsd6) external payable onlyDeed {
        Position storage p = _require(id); _consumeTo(id, block.timestamp);
        require(p.holder == oldHolder && newHolder != address(0), "Invalid replacement");
        uint256 unused = p.balance; teamBalance += unused;
        uint256 daily = dailyRentWei(newPriceUsd6);
        require(msg.value >= daily * 7, "Seven days required");
        p.balance = msg.value; p.priceUsd6 = newPriceUsd6; p.dailyWei = daily;
        p.accountedAt = uint64(block.timestamp); p.zeroAt = 0; p.accrualRemainder = 0; p.holder = newHolder;
        _recordCommit(id, p.ticker, newHolder, msg.value);
        emit PositionReplaced(id, oldHolder, newHolder, unused);
    }

    function preview(uint256 id) public view returns (uint256 balance, uint256 expiresAt, uint256 graceEndsAt) {
        Position memory p = _position[id]; if (!p.opened) return (0,0,0);
        if (p.zeroAt != 0) return (0, p.zeroAt, uint256(p.zeroAt) + GRACE);
        uint256 numeratorLeft = p.balance * 1 days > p.accrualRemainder ? p.balance * 1 days - p.accrualRemainder : 0;
        uint256 secondsLeft = p.dailyWei == 0 ? 0 : (numeratorLeft + p.dailyWei - 1) / p.dailyWei;
        expiresAt = uint256(p.accountedAt) + secondsLeft;
        uint256 charge = (p.dailyWei * (block.timestamp - p.accountedAt) + p.accrualRemainder) / 1 days;
        balance = charge >= p.balance ? 0 : p.balance - charge;
        graceEndsAt = expiresAt + GRACE;
    }
    function position(uint256 id) external view returns (Position memory) { return _position[id]; }
    function dailyRate(uint256 id) external view returns (uint256) { return _position[id].dailyWei; }
    function isLit(uint256 id) external view returns (bool) { (,uint256 expiry,) = preview(id); return expiry != 0 && block.timestamp < expiry; }
    function isGoingDark(uint256 id) external view returns (bool) { (,uint256 expiry,uint256 graceEnd) = preview(id); return expiry != 0 && block.timestamp >= expiry && block.timestamp < graceEnd; }
    function isDark(uint256 id) external view returns (bool) { (,uint256 expiry,uint256 graceEnd) = preview(id); return expiry == 0 || block.timestamp >= graceEnd; }

    function weekOf(uint256 timestamp) public view returns (uint256) { return (timestamp - epoch) / 7 days; }
    function weekEnd(uint256 week) public view returns (uint256) { return uint256(epoch) + (week + 1) * 7 days; }

    /// @notice Sunday-only bounded accounting; keeper repeats batches until the cursor reaches positionCount.
    function checkpointWeek(uint256 week, uint256 limit) external onlyKeeper {
        uint256 end = weekEnd(week); require(block.timestamp >= end && !weekFinalized[week] && limit != 0 && limit <= 250, "Invalid checkpoint");
        uint256 cursor = checkpointCursor[week]; uint256 stop = cursor + limit; if (stop > _ids.length) stop = _ids.length;
        while (cursor < stop) { _consumeTo(_ids[cursor], end); unchecked { ++cursor; } }
        checkpointCursor[week] = cursor;
    }

    function finalizeWeek(uint256 week) external onlyKeeper {
        require(block.timestamp >= weekEnd(week) && checkpointCursor[week] == _ids.length && !weekFinalized[week], "Week not ready");
        weekFinalized[week] = true; emit WeekFinalized(week, distributableRentEth[week]);
    }

    function releaseWeek(uint256 week) external nonReentrant returns (uint256 amount) {
        require(msg.sender == settlement && weekFinalized[week], "Week unavailable");
        amount = distributableRentEth[week];
        distributableRentEth[week] = 0;
        (bool ok,) = payable(settlement).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function claimTeam(address payable recipient) external nonReentrant returns (uint256 amount) {
        require(msg.sender == team && recipient != address(0), "Only team"); amount = teamBalance; teamBalance = 0;
        (bool ok,) = recipient.call{value: amount}(""); require(ok, "Transfer failed");
    }

    function dailyRentWei(uint256 priceUsd6) public view returns (uint256) {
        uint256 dailyUsd6 = priceUsd6 * DAILY_RENT_BPS / BPS;
        return usdToEth(dailyUsd6);
    }

    function usdToEth(uint256 usd6) public view returns (uint256) {
        (uint256 ethUsd6, uint256 updatedAt) = priceFeed.latestPriceUsd6();
        require(ethUsd6 != 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= MAX_ORACLE_AGE, "Oracle unavailable");
        return (usd6 * 1 ether + ethUsd6 - 1) / ethUsd6;
    }

    function _recordCommit(uint256 id, bytes32 ticker, address holder, uint256 amount) private {
        uint256 usd6 = _ethToUsd6(amount); uint256 week = weekOf(block.timestamp);
        clanScoreUsd6[week][ticker] += usd6; holderScoreUsd6[week][holder] += usd6; lifetimeScoreUsd6[holder] += usd6;
        emit RentCommitted(id, ticker, holder, amount, usd6);
    }

    function _consumeTo(uint256 id, uint256 target) private {
        Position storage p = _require(id); if (target <= p.accountedAt || p.balance == 0) return;
        uint256 cursor = p.accountedAt;
        while (cursor < target && p.balance != 0) {
            uint256 week = weekOf(cursor); uint256 end = weekEnd(week); if (end > target) end = target;
            uint256 numerator = p.dailyWei * (end - cursor) + p.accrualRemainder;
            uint256 requested = numerator / 1 days;
            uint256 charge = requested > p.balance ? p.balance : requested;
            if (requested >= p.balance) {
                uint256 needed = p.balance * 1 days > p.accrualRemainder ? p.balance * 1 days - p.accrualRemainder : 0;
                uint256 affordable = p.dailyWei == 0 ? 0 : (needed + p.dailyWei - 1) / p.dailyWei;
                end = cursor + affordable;
                p.zeroAt = uint64(end);
                p.accrualRemainder = 0;
            } else {
                p.accrualRemainder = uint32(numerator % 1 days);
            }
            p.balance -= charge; distributableRentEth[week] += charge; emit RentConsumed(id, week, charge);
            if (charge == 0 && end == cursor) break; cursor = end;
        }
        p.accountedAt = uint64(p.zeroAt == 0 ? target : p.zeroAt);
    }

    function _ethToUsd6(uint256 amount) private view returns (uint256) {
        (uint256 price, uint256 updatedAt) = priceFeed.latestPriceUsd6();
        require(price != 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= MAX_ORACLE_AGE, "Oracle unavailable");
        return amount * price / 1 ether;
    }
    function _require(uint256 id) private view returns (Position storage p) { p = _position[id]; require(p.opened, "Unknown position"); }
    function _supported(bytes32 ticker) private view returns (bool) { for (uint256 i; i < 10; ++i) if (tickers[i] == ticker) return true; return false; }
    function positionCount() external view returns (uint256) { return _ids.length; }
    function positionId(uint256 index) external view returns (uint256) { return _ids[index]; }
}
