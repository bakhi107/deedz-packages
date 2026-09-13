// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {RentIndexV6} from "./RentIndexV6.sol";
import {RentLedgerV6} from "./RentLedgerV6.sol";

/// @title DEEDS v6 Rent Vault
/// @notice Holds ETH rent, accrues it by timestamp, and accounts for the v6 50/25/20/5 split.
contract RentVaultV6 is Ownable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    uint256 public constant DAILY_RENT_BPS = 30;
    uint256 public constant MIN_LIGHT_DAYS = 7;
    uint256 public constant LAPSE_GRACE = 1 days;
    uint256 public constant MAX_ORACLE_AGE = 1 days;

    error InvalidAddress();
    error DeedAlreadyConfigured();
    error OnlyDeed();
    error PositionAlreadyOpen(uint256 tokenId);
    error PositionNotOpen(uint256 tokenId);
    error DepositTooSmall(uint256 supplied, uint256 required);
    error GracePeriodActive(uint256 lapseAvailableAt);
    error TransferFailed();
    error InvalidOraclePrice();
    error StaleOracle(uint256 updatedAt);
    error NotReceiver();

    struct Position {
        uint256 balance;
        uint256 priceUsd6;
        uint256 pendingPriceUsd6;
        uint64 pendingPriceAt;
        uint64 accruedAt;
        uint64 zeroAt;
        bool open;
        uint256 carry;
    }

    IPriceOracle public immutable ethUsdOracle;
    RentIndexV6 public immutable rentIndex;
    mapping(address => uint256) public refunds;
    mapping(uint256 => uint256) public subsidyBalance;
    mapping(uint256 => address) public subsidySource;
    address public rentDiscount;
    RentLedgerV6 public ledger;
    mapping(uint256 => uint256) public lifetimeRentUsd6;
    mapping(uint256 => uint256) public usdCarry;
    mapping(uint256 => bytes32) public positionTicker;
    mapping(uint256 => address) public positionHolder;
    uint256[] private _knownIds;
    mapping(uint256 => bool) private _known;
    mapping(uint256 => uint256) public weekCursor;
    mapping(uint256 => uint256) public weeklyJackpot;
    address public deed;
    address public immutable rentBuyBurnReceiver;
    address public immutable liquidityReceiver;
    address public immutable jackpotReceiver;
    address public immutable teamReceiver;

    uint256 public rentBuyBurnAccrued;
    uint256 public liquidityAccrued;
    uint256 public jackpotAccrued;
    uint256 public teamAccrued;
    uint256 public totalRentCollected;
    uint256 private _liquidityRouted;
    uint256 private _jackpotRouted;
    uint256 private _teamRouted;
    uint256 private _burnRouted;
    uint256 public unallocatedRentDust;

    mapping(uint256 tokenId => Position) private _positions;

    event DeedConfigured(address indexed deed);
    event PositionOpened(uint256 indexed tokenId, uint256 priceUsd6, uint256 deposit);
    event RentAccrued(uint256 indexed tokenId, uint256 amount, uint256 remaining);
    event PriceChanged(uint256 indexed tokenId, uint256 priceUsd6);
    event ToppedUp(uint256 indexed tokenId, uint256 amount, uint256 balance);
    event PositionClosed(uint256 indexed tokenId, address indexed refundReceiver, uint256 refund);
    event BucketClaimed(address indexed receiver, uint256 amount);

    constructor(
        address initialOwner,
        address ethUsdOracle_,
        address rentBuyBurnReceiver_,
        address liquidityReceiver_,
        address jackpotReceiver_,
        address teamReceiver_
    ) Ownable(initialOwner) {
        if (
            ethUsdOracle_ == address(0) || rentBuyBurnReceiver_ == address(0)
                || liquidityReceiver_ == address(0) || jackpotReceiver_ == address(0)
                || teamReceiver_ == address(0)
        ) revert InvalidAddress();
        ethUsdOracle = IPriceOracle(ethUsdOracle_);
        rentIndex = new RentIndexV6(ethUsdOracle_);
        rentBuyBurnReceiver = rentBuyBurnReceiver_;
        liquidityReceiver = liquidityReceiver_;
        jackpotReceiver = jackpotReceiver_;
        teamReceiver = teamReceiver_;
    }

    modifier onlyDeed() {
        if (msg.sender != deed) revert OnlyDeed();
        _;
    }

    function configureDeed(address deed_) external onlyOwner {
        if (deed != address(0)) revert DeedAlreadyConfigured();
        if (deed_ == address(0)) revert InvalidAddress();
        deed = deed_;
        emit DeedConfigured(deed_);
    }

    function configureLedger(address value) external onlyOwner {
        require(address(ledger) == address(0) && _knownIds.length == 0 && value.code.length != 0, "Ledger frozen");
        ledger = RentLedgerV6(value);
    }
    function configureRentDiscount(address value) external onlyOwner {
        require(rentDiscount == address(0) && value.code.length != 0, "Discount frozen"); rentDiscount = value;
    }
    function bindPosition(uint256 id, bytes32 ticker, address holder) external onlyDeed {
        positionTicker[id] = ticker; positionHolder[id] = holder;
    }

    function openPosition(uint256 tokenId, uint256 priceUsd6) external payable onlyDeed {
        rentIndex.sync();
        if (!_known[tokenId]) { _known[tokenId] = true; _knownIds.push(tokenId); }
        Position storage position = _positions[tokenId];
        if (position.open) revert PositionAlreadyOpen(tokenId);
        uint256 required = minimumDeposit(priceUsd6, MIN_LIGHT_DAYS * 1 days);
        if (msg.value < required) revert DepositTooSmall(msg.value, required);
        _positions[tokenId] = Position({
            balance: msg.value,
            priceUsd6: priceUsd6,
            pendingPriceUsd6: 0,
            pendingPriceAt: 0,
            accruedAt: uint64(block.timestamp),
            zeroAt: 0,
            open: true,
            carry: 0
        });
        emit PositionOpened(tokenId, priceUsd6, msg.value);
    }

    function setPrice(uint256 tokenId, uint256 priceUsd6) external onlyDeed {
        _accrue(tokenId);
        Position storage position = _requirePosition(tokenId);
        position.priceUsd6 = priceUsd6;
        position.pendingPriceUsd6 = 0;
        position.pendingPriceAt = 0;
        emit PriceChanged(tokenId, priceUsd6);
    }

    function topUp(uint256 tokenId) external payable onlyDeed {
        _topUp(tokenId);
    }
    function sponsorTopUp(uint256 tokenId, uint256 subsidy) external payable nonReentrant {
        require(msg.sender == rentDiscount && subsidy != 0, "Only rent discount");
        require(subsidy <= msg.value / 10 && (subsidySource[tokenId] == address(0) || subsidySource[tokenId] == msg.sender), "Invalid subsidy");
        _topUp(tokenId);
        subsidySource[tokenId] = msg.sender;
        subsidyBalance[tokenId] += subsidy;
    }
    function _topUp(uint256 tokenId) internal {
        _accrue(tokenId);
        Position storage position = _requirePosition(tokenId);
        require(position.zeroAt == 0 || block.timestamp < uint256(position.zeroAt) + LAPSE_GRACE, "Must lapse and relight");
        position.balance += msg.value;
        if (position.balance != 0) position.zeroAt = 0;
        emit ToppedUp(tokenId, msg.value, position.balance);
    }

    function replacePosition(uint256 tokenId, uint256 newPriceUsd6, uint256 purchaseFee)
        external
        payable
        onlyDeed
        nonReentrant
    {
        _accrue(tokenId);
        Position storage position = _requirePosition(tokenId);
        require(position.zeroAt == 0 || block.timestamp < uint256(position.zeroAt) + LAPSE_GRACE, "Must lapse and relight");
        uint256 unusedRunway = position.balance - subsidyBalance[tokenId];
        _refundSubsidy(tokenId);
        uint256 required = minimumDeposit(newPriceUsd6, MIN_LIGHT_DAYS * 1 days);
        if (msg.value < required + purchaseFee) revert DepositTooSmall(msg.value, required + purchaseFee);
        position.balance = msg.value - purchaseFee;
        position.priceUsd6 = newPriceUsd6;
        position.pendingPriceUsd6 = 0;
        position.pendingPriceAt = 0;
        position.accruedAt = uint64(block.timestamp);
        position.zeroAt = 0;
        teamAccrued += unusedRunway + purchaseFee;
        position.carry = 0;
        emit PositionOpened(tokenId, newPriceUsd6, position.balance);
    }

    function closeLapsed(uint256 tokenId) external onlyDeed {
        _accrue(tokenId);
        Position storage position = _requirePosition(tokenId);
        uint256 availableAt = uint256(position.zeroAt) + LAPSE_GRACE;
        if (position.balance != 0 || position.zeroAt == 0 || block.timestamp < availableAt) {
            revert GracePeriodActive(availableAt);
        }
        delete _positions[tokenId];
        emit PositionClosed(tokenId, address(0), 0);
        delete subsidyBalance[tokenId]; delete subsidySource[tokenId];
    }

    function accrue(uint256 tokenId) external returns (uint256 charged) {
        charged = _accrue(tokenId);
    }

    function claimBucket() external nonReentrant returns (uint256 amount) {
        if (msg.sender == rentBuyBurnReceiver) {
            amount = rentBuyBurnAccrued;
            rentBuyBurnAccrued = 0;
        } else if (msg.sender == liquidityReceiver) {
            amount = liquidityAccrued;
            liquidityAccrued = 0;
        } else if (msg.sender == jackpotReceiver) {
            require(address(ledger) == address(0), "Use weekly jackpot claim");
            amount = jackpotAccrued;
            jackpotAccrued = 0;
        } else if (msg.sender == teamReceiver) {
            amount = teamAccrued;
            teamAccrued = 0;
        } else {
            revert NotReceiver();
        }
        if (amount != 0) _send(payable(msg.sender), amount);
        emit BucketClaimed(msg.sender, amount);
    }

    function minimumDeposit(uint256 priceUsd6, uint256 duration) public view returns (uint256) {
        return dailyRentWei(priceUsd6) * duration / 1 days;
    }

    function dailyRentWei(uint256 priceUsd6) public view returns (uint256) {
        uint256 dailyRentUsd6 = priceUsd6 * DAILY_RENT_BPS / BPS;
        return usdToEth(dailyRentUsd6);
    }

    function usdToEth(uint256 amountUsd6) public view returns (uint256) {
        (uint256 ethUsd6, uint256 updatedAt) = ethUsdOracle.latestPriceUsd6();
        if (ethUsd6 == 0) revert InvalidOraclePrice();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_ORACLE_AGE) revert StaleOracle(updatedAt);
        return (amountUsd6 * 1 ether + ethUsd6 - 1) / ethUsd6;
    }

    function positionOf(uint256 tokenId) external view returns (Position memory) {
        return _positions[tokenId];
    }

    function knownPositionCount() external view returns (uint256) { return _knownIds.length; }
    function knownPositionAt(uint256 index) external view returns (uint256) { return _knownIds[index]; }

    function balanceOf(uint256 tokenId) external view returns (uint256) {
        Position memory position = _positions[tokenId];
        if (!position.open) return 0;
        (uint256 charged,) = _previewCharge(position, block.timestamp);
        return charged >= position.balance ? 0 : position.balance - charged;
    }

    function lapseAvailableAt(uint256 tokenId) external view returns (uint256) {
        Position memory position = _positions[tokenId];
        if (!position.open) return 0;
        (, uint256 projectedZeroAt) = _previewCharge(position, block.timestamp);
        uint256 zeroAt = position.zeroAt == 0 ? projectedZeroAt : position.zeroAt;
        return zeroAt == 0 ? 0 : zeroAt + LAPSE_GRACE;
    }

    function _accrue(uint256 tokenId) internal returns (uint256 charged) {
        charged = _accrueTo(tokenId, block.timestamp);
        require(_positions[tokenId].accruedAt == block.timestamp, "Settle backlog first");
    }

    function settleBacklog(uint256 tokenId) external returns (uint256) { return _accrueTo(tokenId, block.timestamp); }

    function _accrueTo(uint256 tokenId, uint256 target) internal returns (uint256 total) {
        rentIndex.sync();
        for (uint256 i; i < 32 && _positions[tokenId].accruedAt < target; ++i) {
            Position storage p = _requirePosition(tokenId);
            if (p.balance == 0) { p.accruedAt = uint64(target); break; }
            uint256 end = target;
            if (address(ledger) != address(0)) {
                uint256 boundary = ledger.weekEnd(ledger.weekOf(p.accruedAt));
                if (boundary < end) end = boundary;
            }
            total += _settleSegment(tokenId, end);
        }
    }

    function _settleSegment(uint256 tokenId, uint256 end) internal returns (uint256 charged) {
        Position storage position = _requirePosition(tokenId);
        uint256 projectedZeroAt;
        (charged, projectedZeroAt) = _previewCharge(position, end);
        uint256 paidUntil = projectedZeroAt == 0 ? end : projectedZeroAt;
        uint256 usdNumerator = _scaledUsd(position, paidUntil);
        uint256 ethNumerator = _scaledCharge(position, paidUntil) + position.carry;
        if (projectedZeroAt != 0 && ethNumerator != 0) usdNumerator = usdNumerator * charged * 1e27 / ethNumerator;
        usdNumerator += usdCarry[tokenId];
        uint256 usd6 = usdNumerator / (10_000 * 1 days);
        usdCarry[tokenId] = usdNumerator % (10_000 * 1 days);
        lifetimeRentUsd6[tokenId] += usd6;
        if (address(ledger) != address(0) && usd6 != 0) ledger.record(positionTicker[tokenId], positionHolder[tokenId], usd6, paidUntil);
        position.carry = ethNumerator % 1e27;
        if (charged > position.balance) charged = position.balance;
        if (charged != 0) {
            uint256 subsidyUsed = charged * subsidyBalance[tokenId] / position.balance;
            subsidyBalance[tokenId] -= subsidyUsed;
            position.balance -= charged;
            uint256 jackpotShare = _accountSplit(charged);
            if (address(ledger) != address(0)) weeklyJackpot[ledger.weekOf(paidUntil - 1)] += jackpotShare;
            emit RentAccrued(tokenId, charged, position.balance);
        }
        if (position.balance == 0 && position.zeroAt == 0) {
            position.zeroAt = uint64(projectedZeroAt == 0 ? block.timestamp : projectedZeroAt);
        }
        if (position.pendingPriceAt != 0 && end >= position.pendingPriceAt) {
            position.priceUsd6 = position.pendingPriceUsd6;
            position.pendingPriceUsd6 = 0;
            position.pendingPriceAt = 0;
        }
        position.accruedAt = uint64(end);
    }

    function _previewCharge(Position memory position, uint256 end) internal view returns (uint256 charged, uint256 projectedZeroAt) {
        if (!position.open || end <= position.accruedAt || position.balance == 0) return (0, 0);
        charged = (_scaledCharge(position, end) + position.carry) / 1e27;
        if (charged < position.balance) return (charged, 0);
        uint256 lo = position.accruedAt;
        uint256 hi = end;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if ((_scaledCharge(position, mid) + position.carry) / 1e27 >= position.balance) hi = mid;
            else lo = mid + 1;
        }
        return (position.balance, lo);
    }

    function _scaledCharge(Position memory p, uint256 to) internal view returns (uint256 amount) {
        uint256 from = p.accruedAt;
        if (p.pendingPriceAt != 0 && from < p.pendingPriceAt && to >= p.pendingPriceAt) {
            amount = p.priceUsd6 * (rentIndex.indexAt(p.pendingPriceAt) - rentIndex.indexAt(from));
            from = p.pendingPriceAt;
        }
        uint256 price = p.pendingPriceAt != 0 && to >= p.pendingPriceAt ? p.pendingPriceUsd6 : p.priceUsd6;
        return amount + price * (rentIndex.indexAt(to) - rentIndex.indexAt(from));
    }

    function claimRefund(address payable recipient) external nonReentrant returns (uint256 amount) {
        require(recipient != address(0), "Invalid recipient");
        amount = refunds[msg.sender];
        refunds[msg.sender] = 0;
        if (amount != 0) _send(recipient, amount);
    }
    function _refundSubsidy(uint256 id) private {
        refunds[subsidySource[id]] += subsidyBalance[id];
        delete subsidyBalance[id]; delete subsidySource[id];
    }

    function _scaledUsd(Position memory p, uint256 to) internal view returns (uint256 amount) {
        uint256 from = p.accruedAt;
        if (p.pendingPriceAt != 0 && from < p.pendingPriceAt && to >= p.pendingPriceAt) {
            amount = p.priceUsd6 * 30 * (rentIndex.activeSecondsAt(p.pendingPriceAt) - rentIndex.activeSecondsAt(from));
            from = p.pendingPriceAt;
        }
        uint256 price = p.pendingPriceAt != 0 && to >= p.pendingPriceAt ? p.pendingPriceUsd6 : p.priceUsd6;
        return amount + price * 30 * (rentIndex.activeSecondsAt(to) - rentIndex.activeSecondsAt(from));
    }

    function checkpointWeek(uint256 week, uint256 limit) external {
        require(address(ledger) != address(0) && !ledger.sealedWeek(week), "Invalid week");
        uint256 end = ledger.weekEnd(week);
        require(block.timestamp >= end && limit > 0 && limit <= 100, "Invalid checkpoint");
        uint256 cursor = weekCursor[week];
        for (uint256 i; i < limit && cursor < _knownIds.length; ++i) {
            uint256 id = _knownIds[cursor];
            if (_positions[id].open && _positions[id].accruedAt < end) {
                _accrueTo(id, end);
                if (_positions[id].accruedAt < end) break;
            }
            ++cursor;
        }
        weekCursor[week] = cursor;
        if (cursor == _knownIds.length) ledger.seal(week);
    }

    function claimWeeklyJackpot(uint256 week) external nonReentrant returns (uint256 amount) {
        require(msg.sender == jackpotReceiver && ledger.sealedWeek(week), "Jackpot unavailable");
        amount = weeklyJackpot[week]; weeklyJackpot[week] = 0; jackpotAccrued -= amount;
        if (amount != 0) _send(payable(msg.sender), amount);
    }

    function _accountSplit(uint256 amount) internal returns (uint256 jackpot) {
        totalRentCollected += amount;
        uint256 liquidity = totalRentCollected * 25 / 100 - _liquidityRouted;
        jackpot = totalRentCollected * 20 / 100 - _jackpotRouted;
        uint256 team = totalRentCollected * 5 / 100 - _teamRouted;
        uint256 burn = totalRentCollected * 50 / 100 - _burnRouted;
        _liquidityRouted += liquidity; _jackpotRouted += jackpot; _teamRouted += team;
        _burnRouted += burn;
        unallocatedRentDust = totalRentCollected - _liquidityRouted - _jackpotRouted - _teamRouted - _burnRouted;
        liquidityAccrued += liquidity;
        jackpotAccrued += jackpot;
        teamAccrued += team;
        rentBuyBurnAccrued += burn;
    }

    function _currentPrice(Position memory position) internal view returns (uint256) {
        return position.pendingPriceAt != 0 && block.timestamp >= position.pendingPriceAt
            ? position.pendingPriceUsd6
            : position.priceUsd6;
    }

    function _requirePosition(uint256 tokenId) internal view returns (Position storage position) {
        position = _positions[tokenId];
        if (!position.open) revert PositionNotOpen(tokenId);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _send(address payable receiver, uint256 amount) internal {
        (bool success,) = receiver.call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
