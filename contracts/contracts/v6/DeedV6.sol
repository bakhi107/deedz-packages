// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {RentVaultV6} from "./RentVaultV6.sol";
import {DeedArtV6} from "./DeedArtV6.sol";

interface IStockRewardsLifecycleV6 {
    function onLight(bytes32 ticker, address holder) external;
    function onLitTransfer(bytes32 ticker, address from, address to) external;
    function onDark(bytes32 ticker, address holder) external;
    function changeWeight(bytes32 ticker, address holder, int256 delta) external;
    function queueReward(bytes32 ticker) external payable returns (uint256);
}

interface IRentBurnable is IERC20 {
    function burnFrom(address account, uint256 value) external;
}
interface IThroneCheckpointV6 {
    function checkpoint() external;
    function register(bytes32 ticker, uint256 tokenId) external;
}

/// @title DEEDS v6 core NFT
/// @notice Free Dark mint, RENT-powered lighting, ETH rent, and always-for-sale Lit Deeds.
contract DeedV6 is ERC721, ReentrancyGuard, Ownable {
    using Strings for uint256;

    uint256 public constant MIN_PRICE_USD6 = 5e6;
    uint256 public constant LIGHT_COST = 25_000 ether;
    uint256 public constant SALE_FEE_BPS = 500;
    uint256 public constant BPS = 10_000;
    uint16 public constant SUPPLY_PER_TICKER = 250;

    error InvalidAddress();
    error UnsupportedTicker(bytes32 ticker);
    error SupplyExhausted(bytes32 ticker);
    error NotDeedOwner(address account, uint256 tokenId);
    error AlreadyLit(uint256 tokenId);
    error AlreadyDark(uint256 tokenId);
    error PriceBelowMinimum(uint256 priceUsd6);
    error LitTransferRequiresSale();
    error CannotBuyOwnDeed();
    error InsufficientPayment(uint256 supplied, uint256 required);
    error TransferFailed();
    error NotFeeReceiver();

    struct DeedData {
        bytes32 ticker;
        uint16 serial;
        bool lit;
        uint256 priceUsd6;
        uint256 pendingPriceUsd6;
        uint64 pendingPriceAt;
    }

    IRentBurnable public immutable rent;
    RentVaultV6 public immutable rentVault;
    IStockRewardsLifecycleV6 public immutable stockRewards;
    address public immutable stockRewardsReceiver;
    address public immutable liquidityReceiver;
    uint64 public immutable launchedAt;
    DeedArtV6 public immutable artwork;
    mapping(bytes32 => mapping(address => uint256)) public litHoldings;
    mapping(bytes32 => mapping(address => uint256)) public baseWeight;
    uint256 public lightCost = LIGHT_COST;
    address public guardian;
    mapping(bytes32 => bool) public paused;
    mapping(address => uint256) public saleProceeds;
    mapping(uint256 => bool) public throne;
    mapping(bytes32 => bool) public throneMinted;
    address public throneAuction;
    address public thronePool;
    event ScopePaused(bytes32 indexed scope, bool value);

    uint256 public stockRewardsFeeAccrued;
    uint256 public totalSaleFeesCollected;
    uint256 public liquidityFeeAccrued;
    uint256 private _nextTokenId = 1;
    bool private _marketTransfer;

    mapping(bytes32 ticker => bool) public supportedTicker;
    mapping(bytes32 ticker => uint16 supply) public mintedSupply;
    mapping(uint256 tokenId => DeedData) private _deeds;

    event DarkMinted(bytes32 indexed ticker, uint256 indexed tokenId, address indexed owner, uint16 serial);
    event LitUp(bytes32 indexed ticker, uint256 indexed tokenId, address indexed owner, uint256 priceUsd6);
    event Bought(
        bytes32 indexed ticker,
        uint256 indexed tokenId,
        address indexed seller,
        address buyer,
        uint256 paidPriceUsd6,
        uint256 newPriceUsd6
    );
    event PriceScheduled(uint256 indexed tokenId, uint256 oldPriceUsd6, uint256 newPriceUsd6, uint64 effectiveAt);
    event RentToppedUp(uint256 indexed tokenId, address indexed owner, uint256 amount);
    event Darkened(uint256 indexed tokenId, address indexed owner, bool lapsed);
    event SaleFeeClaimed(address indexed receiver, uint256 amount);

    constructor(
        address rent_,
        address rentVault_,
        address stockRewards_,
        address stockRewardsReceiver_,
        address liquidityReceiver_,
        uint64 launchedAt_
    ) ERC721("DEEDZ", "DEED") Ownable(RentVaultV6(payable(rentVault_)).owner()) {
        if (
            rent_ == address(0) || rentVault_ == address(0) || stockRewards_ == address(0)
                || stockRewardsReceiver_ == address(0) || liquidityReceiver_ == address(0)
        ) revert InvalidAddress();
        rent = IRentBurnable(rent_);
        rentVault = RentVaultV6(payable(rentVault_));
        stockRewards = IStockRewardsLifecycleV6(stockRewards_);
        stockRewardsReceiver = stockRewardsReceiver_;
        liquidityReceiver = liquidityReceiver_;
        launchedAt = launchedAt_;
        artwork = new DeedArtV6();

        supportedTicker[bytes32("NVDA")] = true;
        supportedTicker[bytes32("TSLA")] = true;
        supportedTicker[bytes32("AAPL")] = true;
        supportedTicker[bytes32("AMZN")] = true;
        supportedTicker[bytes32("META")] = true;
        supportedTicker[bytes32("MSFT")] = true;
        supportedTicker[bytes32("GOOGL")] = true;
        supportedTicker[bytes32("NFLX")] = true;
        supportedTicker[bytes32("COIN")] = true;
        supportedTicker[bytes32("AMD")] = true;
    }

    function mintDark(bytes32 ticker) external returns (uint256 tokenId) {
        require(!paused[bytes32("mint")] && block.timestamp >= launchedAt, "Mint closed");
        if (!supportedTicker[ticker]) revert UnsupportedTicker(ticker);
        if (mintedSupply[ticker] >= SUPPLY_PER_TICKER) revert SupplyExhausted(ticker);
        tokenId = _nextTokenId++;
        uint16 serial = ++mintedSupply[ticker];
        _deeds[tokenId] = DeedData(ticker, serial, false, 0, 0, 0);
        _safeMint(msg.sender, tokenId);
        emit DarkMinted(ticker, tokenId, msg.sender, serial);
    }

    function lightUp(uint256 tokenId, uint256 priceUsd6) external payable nonReentrant {
        _checkpointThrones();
        // Testnet launch: lighting is available immediately after mint.
        require(!paused[bytes32("light")], "Lighting closed");
        _requireOwner(tokenId);
        DeedData storage data = _deeds[tokenId];
        if (data.lit) revert AlreadyLit(tokenId);
        _requirePrice(priceUsd6);
        rent.burnFrom(msg.sender, lightCost);
        rentVault.bindPosition(tokenId, data.ticker, msg.sender);
        rentVault.openPosition{value: msg.value}(tokenId, priceUsd6);
        data.lit = true;
        data.priceUsd6 = priceUsd6;
        _holding(data.ticker, msg.sender, 1, int256(weightOf(tokenId)));
        emit LitUp(data.ticker, tokenId, msg.sender, priceUsd6);
    }

    function buy(uint256 tokenId, uint256 newPriceUsd6) external payable nonReentrant {
        _buy(tokenId, newPriceUsd6);
    }
    function buyWithLimits(uint256 tokenId, uint256 newPriceUsd6, uint256 maxPriceWei, uint256 deadline) external payable nonReentrant {
        require(block.timestamp <= deadline, "Purchase quote expired");
        DeedData storage quoted = _deeds[tokenId];
        _syncPrice(quoted);
        require(rentVault.usdToEth(quoted.priceUsd6) <= maxPriceWei, "Sale price moved");
        _buy(tokenId, newPriceUsd6);
    }
    function _buy(uint256 tokenId, uint256 newPriceUsd6) internal {
        _checkpointThrones();
        require(!paused[bytes32("buy")], "Purchases paused");
        address seller = ownerOf(tokenId);
        if (seller == msg.sender) revert CannotBuyOwnDeed();
        DeedData storage data = _deeds[tokenId];
        if (!data.lit) revert AlreadyDark(tokenId);
        _syncPrice(data);
        _requirePrice(newPriceUsd6);

        uint256 salePriceWei = rentVault.usdToEth(data.priceUsd6);
        uint256 saleFee = salePriceWei * SALE_FEE_BPS / BPS;
        totalSaleFeesCollected += saleFee;
        uint256 deposit = msg.value > salePriceWei + saleFee ? msg.value - salePriceWei - saleFee : 0;
        uint256 minimumDeposit = rentVault.minimumDeposit(newPriceUsd6, 7 days);
        uint256 required = salePriceWei + saleFee + minimumDeposit;
        if (msg.value < required) revert InsufficientPayment(msg.value, required);

        rentVault.replacePosition{value: deposit + saleFee}(tokenId, newPriceUsd6, saleFee);
        rentVault.bindPosition(tokenId, data.ticker, msg.sender);
        saleProceeds[seller] += salePriceWei;

        _marketTransfer = true;
        _transfer(seller, msg.sender, tokenId);
        _marketTransfer = false;
        uint256 paidPriceUsd6 = data.priceUsd6;
        data.priceUsd6 = newPriceUsd6;
        data.pendingPriceUsd6 = 0;
        data.pendingPriceAt = 0;
        _holding(data.ticker, seller, -1, -int256(weightOf(tokenId)));
        _holding(data.ticker, msg.sender, 1, int256(weightOf(tokenId)));
        emit Bought(data.ticker, tokenId, seller, msg.sender, paidPriceUsd6, newPriceUsd6);
    }

    function setPrice(uint256 tokenId, uint256 newPriceUsd6) external nonReentrant {
        require(!paused[bytes32("reprice")], "Repricing paused");
        _requireOwner(tokenId);
        DeedData storage data = _deeds[tokenId];
        if (!data.lit) revert AlreadyDark(tokenId);
        _syncPrice(data);
        _requirePrice(newPriceUsd6);
        rentVault.setPrice(tokenId, newPriceUsd6);
        uint256 oldPrice = data.priceUsd6;
        data.priceUsd6 = newPriceUsd6;
        data.pendingPriceUsd6 = 0;
        data.pendingPriceAt = 0;
        emit PriceScheduled(tokenId, oldPrice, newPriceUsd6, uint64(block.timestamp));
    }

    function topUpRent(uint256 tokenId) external payable nonReentrant {
        _requireOwner(tokenId);
        if (!_deeds[tokenId].lit) revert AlreadyDark(tokenId);
        rentVault.topUp{value: msg.value}(tokenId);
        emit RentToppedUp(tokenId, msg.sender, msg.value);
    }

    function lapse(uint256 tokenId) external nonReentrant {
        _checkpointThrones();
        address holder = ownerOf(tokenId);
        DeedData storage data = _deeds[tokenId];
        if (!data.lit) revert AlreadyDark(tokenId);
        rentVault.closeLapsed(tokenId);
        _holding(data.ticker, holder, -1, -int256(weightOf(tokenId)));
        _makeDark(data);
        emit Darkened(tokenId, holder, true);
    }

    function claimSaleFee() external nonReentrant returns (uint256 amount) {
        if (msg.sender == stockRewardsReceiver) {
            amount = stockRewardsFeeAccrued;
            stockRewardsFeeAccrued = 0;
        } else if (msg.sender == liquidityReceiver) {
            amount = liquidityFeeAccrued;
            liquidityFeeAccrued = 0;
        } else {
            revert NotFeeReceiver();
        }
        if (amount != 0) _send(payable(msg.sender), amount);
        emit SaleFeeClaimed(msg.sender, amount);
    }

    function deedData(uint256 tokenId) external view returns (DeedData memory data) {
        ownerOf(tokenId);
        data = _deeds[tokenId];
        if (data.pendingPriceAt != 0 && block.timestamp >= data.pendingPriceAt) {
            data.priceUsd6 = data.pendingPriceUsd6;
            data.pendingPriceUsd6 = 0;
            data.pendingPriceAt = 0;
        }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId);
        DeedData memory data = _deeds[tokenId];
        if (data.pendingPriceAt != 0 && block.timestamp >= data.pendingPriceAt) data.priceUsd6 = data.pendingPriceUsd6;
        uint256 runway;
        if (data.lit) {
            try rentVault.dailyRentWei(data.priceUsd6) returns (uint256 daily) {
                runway = daily == 0 ? 0 : rentVault.balanceOf(tokenId) * 1e6 / daily;
            } catch { /* Metadata must remain readable during oracle outages. */ }
        }
        return artwork.render(DeedArtV6.Card(data.ticker, data.serial, data.lit, data.priceUsd6,
            runway, false, throne[tokenId], rentVault.lifetimeRentUsd6(tokenId)));
    }

    function claimSaleProceeds(address payable recipient) external nonReentrant returns (uint256 amount) {
        require(recipient != address(0), "Invalid recipient");
        amount = saleProceeds[msg.sender];
        saleProceeds[msg.sender] = 0;
        if (amount != 0) _send(recipient, amount);
    }

    function setGuardian(address value) external onlyOwner { guardian = value; }
    function configureThronePool(address value) external onlyOwner {
        require(thronePool == address(0) && value.code.length != 0, "Throne pool frozen"); thronePool = value;
    }
    function _checkpointThrones() internal { if (thronePool != address(0)) IThroneCheckpointV6(thronePool).checkpoint(); }
    function setPause(bytes32 scope, bool value) external {
        require(msg.sender == owner() || (msg.sender == guardian && value), "Unauthorized pause");
        paused[scope] = value;
        emit ScopePaused(scope, value);
    }
    function lowerLightCost(uint256 value) external onlyOwner {
        require(value <= lightCost, "Downward only");
        lightCost = value;
    }
    function _holding(bytes32 ticker, address holder, int256 count, int256 weight) internal {
        if (count > 0) litHoldings[ticker][holder] += uint256(count); else litHoldings[ticker][holder] -= uint256(-count);
        if (weight > 0) baseWeight[ticker][holder] += uint256(weight); else baseWeight[ticker][holder] -= uint256(-weight);
        stockRewards.changeWeight(ticker, holder, weight);
    }
    function configureThroneAuction(address auction) external onlyOwner {
        require(throneAuction == address(0), "Throne auction frozen");
        require(auction == address(0) || auction.code.length != 0, "Invalid auction");
        throneAuction = auction;
    }
    function weightOf(uint256 id) public view returns (uint256) { return throne[id] ? 14 : 2; }
    function mintThrone(bytes32 ticker, address recipient) external returns (uint256 id) {
        require(msg.sender == throneAuction && throneAuction != address(0), "Only auction");
        require(supportedTicker[ticker] && !throneMinted[ticker], "Throne unavailable");
        throneMinted[ticker] = true;
        id = _nextTokenId++;
        throne[id] = true;
        _deeds[id] = DeedData(ticker, 0, false, 0, 0, 0);
        _mint(recipient, id);
        if (thronePool != address(0)) IThroneCheckpointV6(thronePool).register(ticker, id);
        emit DarkMinted(ticker, id, recipient, 0);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _deeds[tokenId].lit && !_marketTransfer) {
            revert LitTransferRequiresSale();
        }
        return super._update(to, tokenId, auth);
    }

    function _syncPrice(DeedData storage data) internal {
        if (data.pendingPriceAt != 0 && block.timestamp >= data.pendingPriceAt) {
            data.priceUsd6 = data.pendingPriceUsd6;
            data.pendingPriceUsd6 = 0;
            data.pendingPriceAt = 0;
        }
    }

    function _makeDark(DeedData storage data) internal {
        data.lit = false;
        data.priceUsd6 = 0;
        data.pendingPriceUsd6 = 0;
        data.pendingPriceAt = 0;
    }

    function _requireOwner(uint256 tokenId) internal view {
        if (ownerOf(tokenId) != msg.sender) revert NotDeedOwner(msg.sender, tokenId);
    }

    function _requirePrice(uint256 priceUsd6) internal pure {
        if (priceUsd6 < MIN_PRICE_USD6) revert PriceBelowMinimum(priceUsd6);
    }

    function _tickerString(bytes32 value) internal pure returns (string memory) {
        uint256 length;
        while (length < 32 && value[length] != 0) ++length;
        bytes memory result = new bytes(length);
        for (uint256 i; i < length; ++i) result[i] = value[i];
        return string(result);
    }

    function _send(address payable receiver, uint256 amount) internal {
        (bool success,) = receiver.call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
