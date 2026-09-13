// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title TaxVault
/// @notice Holds Stock Token deposits and lazily streams Harberger tax into protocol accounting.
contract TaxVault is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant DAILY_TAX_BPS = 30; // 0.3% per day
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant DAY = 86_400;
    uint256 public constant MAX_ORACLE_AGE = 1 hours;
    uint256 public constant TOKEN_SCALE = 1e18;

    error InvalidAddress();
    error InvalidAmount();
    error PositionAlreadyOpen(uint256 tokenId);
    error PositionNotOpen(uint256 tokenId);
    error WrongHolder(address expected, address actual);
    error PositionNotDepleted(uint256 tokenId);
    error OracleUnavailable();
    error InsufficientDeposit(uint256 required, uint256 provided);

    struct Position {
        address holder;
        address stockToken;
        address priceOracle;
        uint256 balance;
        uint256 assessedPriceUsd6;
        uint256 accrualRemainder;
        uint256 pendingPriceUsd6;
        uint64 pendingPriceBlock;
        uint64 lastAccrued;
        bool active;
    }

    mapping(uint256 tokenId => Position position) private _positions;
    mapping(address stockToken => uint256 amount) public liquidityAccrued;
    mapping(address stockToken => uint256 amount) public treasuryAccrued;
    mapping(address holder => uint256 amountUsd6) public lifetimeTaxUsd6;

    address public immutable liquidityReceiver;
    address public immutable treasury;

    event PositionOpened(uint256 indexed tokenId, address indexed holder, address indexed stockToken, uint256 deposit);
    event Deposited(uint256 indexed tokenId, address indexed payer, uint256 amount);
    event TaxAccrued(uint256 indexed tokenId, uint256 stockTokenAmount, uint256 usdAmount);
    event AccrualPaused(uint256 indexed tokenId, uint256 oracleUpdatedAt);
    event PositionDepleted(uint256 indexed tokenId);
    event PositionClosed(uint256 indexed tokenId, address indexed refundTo, uint256 refund);
    event PriceUpdated(uint256 indexed tokenId, uint256 assessedPriceUsd6);
    event Disbursed(address indexed stockToken, uint256 liquidityAmount, uint256 treasuryAmount);

    constructor(address market, address liquidityReceiver_, address treasury_) Ownable(market) {
        if (market == address(0) || liquidityReceiver_ == address(0) || treasury_ == address(0)) revert InvalidAddress();
        liquidityReceiver = liquidityReceiver_;
        treasury = treasury_;
    }

    function openPosition(
        uint256 tokenId,
        address holder,
        address stockToken,
        address priceOracle,
        uint256 assessedPriceUsd6,
        uint256 depositAmount
    ) external onlyOwner {
        if (_positions[tokenId].active) revert PositionAlreadyOpen(tokenId);
        if (holder == address(0) || stockToken == address(0) || priceOracle == address(0)) revert InvalidAddress();
        if (assessedPriceUsd6 == 0 || assessedPriceUsd6 > type(uint128).max || depositAmount == 0) {
            revert InvalidAmount();
        }
        uint256 requiredDeposit = minimumDeposit(priceOracle, assessedPriceUsd6, 3 * DAY);
        if (depositAmount < requiredDeposit) revert InsufficientDeposit(requiredDeposit, depositAmount);

        IERC20(stockToken).safeTransferFrom(holder, address(this), depositAmount);
        _positions[tokenId] = Position({
            holder: holder,
            stockToken: stockToken,
            priceOracle: priceOracle,
            balance: depositAmount,
            assessedPriceUsd6: assessedPriceUsd6,
            accrualRemainder: 0,
            pendingPriceUsd6: 0,
            pendingPriceBlock: 0,
            lastAccrued: uint64(block.timestamp),
            active: true
        });
        emit PositionOpened(tokenId, holder, stockToken, depositAmount);
    }

    function deposit(uint256 tokenId, address payer, uint256 amount) external onlyOwner {
        Position storage position = _requirePosition(tokenId);
        if (payer != position.holder) revert WrongHolder(position.holder, payer);
        if (amount == 0) revert InvalidAmount();
        IERC20(position.stockToken).safeTransferFrom(payer, address(this), amount);
        position.balance += amount;
        emit Deposited(tokenId, payer, amount);
    }

    function schedulePrice(uint256 tokenId, uint256 assessedPriceUsd6, uint64 effectiveBlock) external onlyOwner {
        if (assessedPriceUsd6 == 0 || assessedPriceUsd6 > type(uint128).max) revert InvalidAmount();
        _accrue(tokenId);
        Position storage position = _requirePosition(tokenId);
        position.pendingPriceUsd6 = assessedPriceUsd6;
        position.pendingPriceBlock = effectiveBlock;
        emit PriceUpdated(tokenId, assessedPriceUsd6);
    }

    function replaceHolder(uint256 tokenId, address newHolder, uint256 newPriceUsd6, uint256 depositAmount)
        external
        onlyOwner
    {
        if (
            newHolder == address(0) || newPriceUsd6 == 0 || newPriceUsd6 > type(uint128).max || depositAmount == 0
        ) revert InvalidAmount();
        Position storage position = _requirePosition(tokenId);
        uint256 requiredDeposit = minimumDeposit(position.priceOracle, newPriceUsd6, 3 * DAY);
        if (depositAmount < requiredDeposit) revert InsufficientDeposit(requiredDeposit, depositAmount);
        _accrue(tokenId);
        address previousHolder = position.holder;
        uint256 refund = position.balance;
        position.balance = 0;
        if (refund != 0) IERC20(position.stockToken).safeTransfer(previousHolder, refund);

        IERC20(position.stockToken).safeTransferFrom(newHolder, address(this), depositAmount);
        position.holder = newHolder;
        position.balance = depositAmount;
        position.assessedPriceUsd6 = newPriceUsd6;
        position.accrualRemainder = 0;
        position.pendingPriceUsd6 = 0;
        position.pendingPriceBlock = 0;
        position.lastAccrued = uint64(block.timestamp);
        emit PositionClosed(tokenId, previousHolder, refund);
        emit PositionOpened(tokenId, newHolder, position.stockToken, depositAmount);
    }

    function accrue(uint256 tokenId) external returns (uint256 taxTokenAmount) {
        return _accrue(tokenId);
    }

    function closeDepleted(uint256 tokenId) external onlyOwner {
        _accrue(tokenId);
        Position storage position = _requirePosition(tokenId);
        if (position.balance != 0) revert PositionNotDepleted(tokenId);
        position.active = false;
        emit PositionClosed(tokenId, position.holder, 0);
    }

    function disburse(address stockToken) external {
        uint256 liquidityAmount = liquidityAccrued[stockToken];
        uint256 treasuryAmount = treasuryAccrued[stockToken];
        liquidityAccrued[stockToken] = 0;
        treasuryAccrued[stockToken] = 0;

        if (liquidityAmount != 0) IERC20(stockToken).safeTransfer(liquidityReceiver, liquidityAmount);
        if (treasuryAmount != 0) IERC20(stockToken).safeTransfer(treasury, treasuryAmount);
        emit Disbursed(stockToken, liquidityAmount, treasuryAmount);
    }

    function positionOf(uint256 tokenId) external view returns (Position memory) {
        Position memory position = _positions[tokenId];
        if (!position.active) revert PositionNotOpen(tokenId);
        return position;
    }

    function balanceOf(uint256 tokenId) external view returns (uint256) {
        return _requirePosition(tokenId).balance;
    }

    function minimumDeposit(address priceOracle, uint256 assessedPriceUsd6, uint256 duration)
        public
        view
        returns (uint256)
    {
        (uint256 stockPriceUsd6, uint256 updatedAt) = IPriceOracle(priceOracle).latestPriceUsd6();
        if (!_isFresh(stockPriceUsd6, updatedAt)) revert OracleUnavailable();
        uint256 taxUsd6 = Math.mulDiv(
            assessedPriceUsd6,
            DAILY_TAX_BPS * duration,
            BPS_DENOMINATOR * DAY,
            Math.Rounding.Ceil
        );
        return Math.mulDiv(taxUsd6, TOKEN_SCALE, stockPriceUsd6, Math.Rounding.Ceil);
    }

    function runway(uint256 tokenId) external view returns (uint256 secondsRemaining) {
        Position storage position = _positions[tokenId];
        if (!position.active) revert PositionNotOpen(tokenId);
        (uint256 stockPriceUsd6, uint256 updatedAt) = IPriceOracle(position.priceOracle).latestPriceUsd6();
        if (!_isFresh(stockPriceUsd6, updatedAt)) return 0;

        uint256 assessedPriceUsd6 = _effectivePrice(position);
        uint256 dailyTaxUsd6 = Math.mulDiv(assessedPriceUsd6, DAILY_TAX_BPS, BPS_DENOMINATOR);
        uint256 dailyTaxTokens = Math.mulDiv(dailyTaxUsd6, TOKEN_SCALE, stockPriceUsd6);
        if (dailyTaxTokens == 0) return type(uint256).max;
        return Math.mulDiv(position.balance, DAY, dailyTaxTokens);
    }

    function _accrue(uint256 tokenId) private returns (uint256 taxTokenAmount) {
        Position storage position = _requirePosition(tokenId);
        uint256 elapsed = block.timestamp - position.lastAccrued;
        if (elapsed == 0 || position.balance == 0) return 0;
        position.lastAccrued = uint64(block.timestamp);

        if (position.pendingPriceBlock != 0 && block.number >= position.pendingPriceBlock) {
            position.assessedPriceUsd6 = position.pendingPriceUsd6;
            position.pendingPriceUsd6 = 0;
            position.pendingPriceBlock = 0;
        }

        (uint256 stockPriceUsd6, uint256 updatedAt) = IPriceOracle(position.priceOracle).latestPriceUsd6();
        if (!_isFresh(stockPriceUsd6, updatedAt)) {
            emit AccrualPaused(tokenId, updatedAt);
            return 0;
        }

        uint256 denominator = BPS_DENOMINATOR * DAY;
        uint256 numerator = position.assessedPriceUsd6 * DAILY_TAX_BPS * elapsed + position.accrualRemainder;
        uint256 taxUsd6 = numerator / denominator;
        position.accrualRemainder = numerator % denominator;
        taxTokenAmount = Math.mulDiv(taxUsd6, TOKEN_SCALE, stockPriceUsd6);
        if (taxTokenAmount > position.balance) taxTokenAmount = position.balance;
        if (taxTokenAmount == 0) return 0;

        position.balance -= taxTokenAmount;
        uint256 paidUsd6 = Math.mulDiv(taxTokenAmount, stockPriceUsd6, TOKEN_SCALE);
        uint256 liquidityShare = taxTokenAmount * 90 / 100;
        liquidityAccrued[position.stockToken] += liquidityShare;
        treasuryAccrued[position.stockToken] += taxTokenAmount - liquidityShare;
        lifetimeTaxUsd6[position.holder] += paidUsd6;
        emit TaxAccrued(tokenId, taxTokenAmount, paidUsd6);
        if (position.balance == 0) emit PositionDepleted(tokenId);
    }

    function _requirePosition(uint256 tokenId) private view returns (Position storage position) {
        position = _positions[tokenId];
        if (!position.active) revert PositionNotOpen(tokenId);
    }

    function _isFresh(uint256 priceUsd6, uint256 updatedAt) private view returns (bool) {
        return priceUsd6 != 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= MAX_ORACLE_AGE;
    }

    function _effectivePrice(Position storage position) private view returns (uint256) {
        if (position.pendingPriceBlock != 0 && block.number >= position.pendingPriceBlock) {
            return position.pendingPriceUsd6;
        }
        return position.assessedPriceUsd6;
    }
}
