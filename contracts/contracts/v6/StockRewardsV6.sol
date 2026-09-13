// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardAdapterV6 {
    function swapExactEthForToken(address token, uint256 minimum, uint256 deadline, bytes calldata data)
        external payable returns (uint256);
}
interface ITradingCheckpointV6 { function checkpointTradingFees() external; }

/// @title DEEDS v6 Stock Token reward ledger
/// @notice Tracks Lit weight and lets holders pull Stock Token rewards without iterating over holders.
contract StockRewardsV6 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ACCURACY = 1e27;
    uint256 public constant STANDARD_WEIGHT = 2;

    error InvalidAddress();
    error AlreadyConfigured();
    error OnlyDeed();
    error OnlyStockBuyer();
    error UnsupportedTicker(bytes32 ticker);
    error NoLitWeight(bytes32 ticker);
    error InsufficientWeight();
    error ZeroAmount();
    error IncorrectTransfer(uint256 expected, uint256 received);

    struct HolderState {
        uint256 weight;
        uint256 rewardDebt;
        uint256 claimable;
    }

    address public deed;
    address public stockBuyer;
    mapping(bytes32 ticker => IERC20 token) public stockToken;
    mapping(bytes32 ticker => uint256 weight) public totalWeight;
    mapping(bytes32 ticker => uint256 accumulatedPerWeight) public rewardPerWeight;
    mapping(bytes32 ticker => uint256 amount) public totalDistributed;
    mapping(bytes32 ticker => mapping(address holder => HolderState state)) private _holder;
    struct WeightPoint { uint256 version; uint256 weight; }
    struct Batch {
        bytes32 ticker;
        uint256 version;
        uint256 weight;
        uint256 ethRemaining;
        uint256 tokenAmount;
        uint256 weightRemaining;
        bool failed;
        bool converted;
    }
    uint256 public version;
    mapping(uint256 => uint256) public versionTime;
    mapping(bytes32 => mapping(address => WeightPoint[])) private _history;
    mapping(bytes32 => WeightPoint[]) private _totalHistory;
    mapping(address => bool) public rewardSource;
    Batch[] public batches;
    mapping(uint256 => mapping(address => bool)) public batchClaimed;
    mapping(uint256 => address) public batchBeneficiary;
    mapping(bytes32 => uint256[]) private _tickerBatches;
    event RewardQueued(uint256 indexed batchId, bytes32 indexed ticker, uint256 ethAmount, uint256 version);
    event ConversionFailed(uint256 indexed batchId, bytes reason);
    event BatchConverted(uint256 indexed batchId, uint256 ethAmount, uint256 tokenAmount);
    event BatchClaimed(uint256 indexed batchId, address indexed holder, bool inEth, uint256 amount);

    event DeedConfigured(address indexed deed);
    event StockBuyerConfigured(address indexed stockBuyer);
    event TickerConfigured(bytes32 indexed ticker, address indexed stockToken);
    event WeightChanged(bytes32 indexed ticker, address indexed holder, uint256 oldWeight, uint256 newWeight);
    event RewardDeposited(bytes32 indexed ticker, address indexed stockToken, uint256 amount);
    event RewardClaimed(bytes32 indexed ticker, address indexed holder, uint256 amount);

    constructor(address initialOwner) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
    }

    function configureDeed(address deed_) external onlyOwner {
        if (deed_ == address(0)) revert InvalidAddress();
        if (deed != address(0)) revert AlreadyConfigured();
        deed = deed_;
        emit DeedConfigured(deed_);
    }

    function configureStockBuyer(address stockBuyer_) external onlyOwner {
        if (stockBuyer_ == address(0)) revert InvalidAddress();
        if (stockBuyer != address(0)) revert AlreadyConfigured();
        stockBuyer = stockBuyer_;
        emit StockBuyerConfigured(stockBuyer_);
    }

    function configureTicker(bytes32 ticker, address token) external onlyOwner {
        if (ticker == bytes32(0) || token.code.length == 0) revert InvalidAddress();
        if (address(stockToken[ticker]) != address(0)) revert AlreadyConfigured();
        stockToken[ticker] = IERC20(token);
        emit TickerConfigured(ticker, token);
    }

    function onLight(bytes32 ticker, address holder) external {
        _onlyDeed();
        _changeWeight(ticker, holder, int256(STANDARD_WEIGHT));
    }

    function onLitTransfer(bytes32 ticker, address from, address to) external {
        _onlyDeed();
        if (from == to) return;
        _changeWeight(ticker, from, -int256(STANDARD_WEIGHT));
        _changeWeight(ticker, to, int256(STANDARD_WEIGHT));
    }

    function onDark(bytes32 ticker, address holder) external {
        _onlyDeed();
        _changeWeight(ticker, holder, -int256(STANDARD_WEIGHT));
    }

    function changeWeight(bytes32 ticker, address holder, int256 delta) external {
        _onlyDeed();
        _changeWeight(ticker, holder, delta);
    }

    function configureRewardSource(address source, bool allowed) external onlyOwner {
        require(source.code.length != 0, "Invalid source");
        rewardSource[source] = allowed;
    }

    function queueReward(bytes32 ticker) external payable returns (uint256 id) {
        return _queue(ticker, version);
    }

    function queueDirectReward(bytes32 ticker, address beneficiary) external payable returns (uint256 id) {
        require(rewardSource[msg.sender] && beneficiary != address(0) && address(stockToken[ticker]) != address(0), "Invalid direct reward");
        require(msg.value != 0, "Empty reward");
        id = batches.length;
        batches.push(Batch(ticker, version, 1, msg.value, 0, 1, false, false));
        batchBeneficiary[id] = beneficiary;
        _tickerBatches[ticker].push(id);
        emit RewardQueued(id, ticker, msg.value, version);
    }

    function queueSnapshotReward(bytes32 ticker, uint256 snapshot) external payable returns (uint256 id) {
        require(rewardSource[msg.sender] && snapshot <= version, "Invalid snapshot source");
        return _queue(ticker, snapshot);
    }

    function _queue(bytes32 ticker, uint256 snapshot) internal returns (uint256 id) {
        require(msg.sender == deed || msg.sender == stockBuyer || rewardSource[msg.sender], "Only reward source");
        uint256 weight = _lookup(_totalHistory[ticker], snapshot);
        if (weight == 0) revert NoLitWeight(ticker);
        if (msg.value == 0) revert ZeroAmount();
        id = batches.length;
        batches.push(Batch(ticker, snapshot, weight, msg.value, 0, weight, false, false));
        _tickerBatches[ticker].push(id);
        emit RewardQueued(id, ticker, msg.value, snapshot);
    }

    /// @notice Failure is isolated in a subcall. ETH remains owned by the original snapshot.
    function convertBatch(uint256 id, address adapter, uint256 minimum, uint256 deadline, bytes calldata data)
        external nonReentrant returns (uint256 amount)
    {
        if (msg.sender != stockBuyer) revert OnlyStockBuyer();
        require(minimum != 0 && deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "Invalid quote");
        Batch storage b = batches[id];
        require(!b.converted && b.ethRemaining != 0, "Batch closed");
        try this.executeConversion(id, adapter, minimum, deadline, data) returns (uint256 received) {
            amount = received;
            b.tokenAmount = received;
            b.converted = true;
            b.failed = false;
            emit BatchConverted(id, b.ethRemaining, received);
            b.ethRemaining = 0;
        } catch (bytes memory reason) {
            b.failed = true;
            emit ConversionFailed(id, reason);
        }
    }

    function executeConversion(uint256 id, address adapter, uint256 minimum, uint256 deadline, bytes calldata data)
        external returns (uint256 received)
    {
        require(msg.sender == address(this), "Only self");
        Batch storage b = batches[id];
        IERC20 token = stockToken[b.ticker];
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 reported = IRewardAdapterV6(adapter).swapExactEthForToken{value: b.ethRemaining}(
            address(token), minimum, deadline, data);
        received = token.balanceOf(address(this)) - beforeBalance;
        require(received >= minimum && received == reported, "Inexact swap");
    }

    function claimBatch(uint256 id, address payable recipient, bool inEth) external nonReentrant returns (uint256 amount) {
        require(recipient != address(0), "Invalid recipient");
        Batch storage b = batches[id];
        require(!batchClaimed[id][msg.sender], "Already claimed");
        address direct = batchBeneficiary[id];
        uint256 weight = direct == address(0) ? _lookup(_history[b.ticker][msg.sender], b.version) : (direct == msg.sender ? 1 : 0);
        require(weight != 0, "Not in snapshot");
        batchClaimed[id][msg.sender] = true;
        if (inEth) {
            require(b.failed && !b.converted, "ETH fallback unavailable");
            amount = b.ethRemaining * weight / b.weightRemaining;
            b.ethRemaining -= amount;
            b.weightRemaining -= weight;
            (bool sent,) = recipient.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            require(b.converted, "Not converted");
            amount = b.tokenAmount * weight / b.weightRemaining;
            b.tokenAmount -= amount;
            b.weightRemaining -= weight;
            IERC20 token = stockToken[b.ticker];
            uint256 beforeBalance = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            require(token.balanceOf(recipient) - beforeBalance == amount, "Inexact claim");
        }
        emit BatchClaimed(id, msg.sender, inEth, amount);
    }

    function batchCount() external view returns (uint256) { return batches.length; }
    function versionBefore(uint256 timestamp) external view returns (uint256) {
        uint256 lo;
        uint256 hi = version + 1;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            if (versionTime[mid] < timestamp) lo = mid; else hi = mid;
        }
        return lo;
    }
    function totalWeightAt(bytes32 ticker, uint256 snapshot) external view returns (uint256) {
        return _lookup(_totalHistory[ticker], snapshot);
    }
    function tickerBatchIds(bytes32 ticker) external view returns (uint256[] memory) { return _tickerBatches[ticker]; }
    function weightAt(bytes32 ticker, address holder, uint256 snapshot) external view returns (uint256) {
        return _lookup(_history[ticker][holder], snapshot);
    }
    function _lookup(WeightPoint[] storage history, uint256 snapshot) internal view returns (uint256) {
        uint256 lo;
        uint256 hi = history.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (history[mid].version <= snapshot) lo = mid + 1; else hi = mid;
        }
        return lo == 0 ? 0 : history[lo - 1].weight;
    }

    function depositReward(bytes32 ticker, uint256 amount) external nonReentrant {
        if (msg.sender != stockBuyer) revert OnlyStockBuyer();
        IERC20 token = stockToken[ticker];
        if (address(token) == address(0)) revert UnsupportedTicker(ticker);
        uint256 weight = totalWeight[ticker];
        if (weight == 0) revert NoLitWeight(ticker);
        if (amount == 0) revert ZeroAmount();
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert IncorrectTransfer(amount, received);
        rewardPerWeight[ticker] += amount * ACCURACY / weight;
        totalDistributed[ticker] += amount;
        emit RewardDeposited(ticker, address(token), amount);
    }

    function claim(bytes32 ticker) external nonReentrant returns (uint256 amount) {
        IERC20 token = stockToken[ticker];
        if (address(token) == address(0)) revert UnsupportedTicker(ticker);
        _settle(ticker, msg.sender);
        HolderState storage state = _holder[ticker][msg.sender];
        amount = state.claimable;
        state.claimable = 0;
        token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(ticker, msg.sender, amount);
    }

    function holderState(bytes32 ticker, address holder) external view returns (HolderState memory state) {
        state = _holder[ticker][holder];
        uint256 accumulated = state.weight * rewardPerWeight[ticker] / ACCURACY;
        if (accumulated > state.rewardDebt) state.claimable += accumulated - state.rewardDebt;
    }

    function pendingReward(bytes32 ticker, address holder) external view returns (uint256) {
        HolderState memory state = _holder[ticker][holder];
        uint256 accumulated = state.weight * rewardPerWeight[ticker] / ACCURACY;
        return state.claimable + (accumulated > state.rewardDebt ? accumulated - state.rewardDebt : 0);
    }

    function _changeWeight(bytes32 ticker, address holder, int256 delta) internal {
        if (stockBuyer != address(0)) ITradingCheckpointV6(stockBuyer).checkpointTradingFees();
        if (address(stockToken[ticker]) == address(0)) revert UnsupportedTicker(ticker);
        _settle(ticker, holder);
        HolderState storage state = _holder[ticker][holder];
        uint256 oldWeight = state.weight;
        if (delta > 0) {
            uint256 increase = uint256(delta);
            state.weight += increase;
            totalWeight[ticker] += increase;
        } else {
            uint256 decrease = uint256(-delta);
            if (state.weight < decrease) revert InsufficientWeight();
            state.weight -= decrease;
            totalWeight[ticker] -= decrease;
        }
        state.rewardDebt = state.weight * rewardPerWeight[ticker] / ACCURACY;
        ++version;
        versionTime[version] = block.timestamp;
        _history[ticker][holder].push(WeightPoint(version, state.weight));
        _totalHistory[ticker].push(WeightPoint(version, totalWeight[ticker]));
        emit WeightChanged(ticker, holder, oldWeight, state.weight);
    }

    function _settle(bytes32 ticker, address holder) internal {
        HolderState storage state = _holder[ticker][holder];
        uint256 accumulated = state.weight * rewardPerWeight[ticker] / ACCURACY;
        if (accumulated > state.rewardDebt) state.claimable += accumulated - state.rewardDebt;
        state.rewardDebt = accumulated;
    }

    function _onlyDeed() internal view {
        if (msg.sender != deed) revert OnlyDeed();
    }
}
