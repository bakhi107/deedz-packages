// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IGeoGate} from "./interfaces/IGeoGate.sol";
import {ITickerRegistry} from "./interfaces/ITickerRegistry.sol";
import {ITaxVault} from "./interfaces/ITaxVault.sol";
import {ILandlordRegistry} from "./interfaces/ILandlordRegistry.sol";
import {IFloorManager} from "./interfaces/IFloorManager.sol";

/// @title Deed
/// @notice Always-for-sale positions in a ticker's future fee stream.
contract Deed is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    using Strings for address;

    uint256 public constant MIN_PRICE = 5e6;
    uint256 public constant CLAIM_FEE = 1e6;
    uint8 public constant MAX_CLAIMS_PER_WALLET = 5;
    uint256 public constant FLOOR_GRACE_PERIOD = 1 days;

    error IneligibleAccount(address account);
    error InvalidAddress();
    error InactiveTicker(bytes32 ticker);
    error SupplyExhausted(bytes32 ticker);
    error ClaimLimitReached(address account);
    error PriceBelowFloor(uint256 price, uint256 floor);
    error NotDeedOwner(address account, uint256 tokenId);
    error CannotBuyOwnDeed();
    error MarketTransferOnly();
    error ApprovalsDisabled();
    error PositionHasRunway(uint256 tokenId);
    error DeedNotForeclosed(uint256 tokenId);

    struct DeedData {
        bytes32 ticker;
        uint16 serial;
        uint256 price;
        uint256 pendingPrice;
        uint64 pendingPriceBlock;
    }

    ITickerRegistry public immutable registry;
    IGeoGate public immutable geoGate;
    ITaxVault public immutable taxVault;
    ILandlordRegistry public immutable landlordRegistry;
    IFloorManager public immutable floorManager;
    IERC20 public immutable usdg;
    address public immutable treasury;

    uint256 private _nextTokenId = 1;
    bool private _marketTransfer;

    mapping(uint256 tokenId => DeedData data) private _deeds;
    mapping(bytes32 ticker => uint16 claimed) public claimedSupply;
    mapping(address account => uint8 claims) public walletClaims;

    event Claimed(bytes32 indexed ticker, uint256 indexed tokenId, address indexed owner, uint16 serial, uint256 price);
    event Bought(bytes32 indexed ticker, uint256 indexed tokenId, address indexed from, address to, uint256 paidPrice, uint256 newPrice);
    event RepriceScheduled(uint256 indexed tokenId, uint256 oldPrice, uint256 newPrice, uint64 effectiveBlock);
    event Foreclosed(bytes32 indexed ticker, uint256 indexed tokenId, address indexed formerOwner);
    event FloorEnforced(uint256 indexed tokenId, uint256 oldPrice, uint256 floorPrice);

    constructor(
        address registry_,
        address geoGate_,
        address taxVault_,
        address landlordRegistry_,
        address floorManager_,
        address usdg_,
        address treasury_
    )
        ERC721("DEEDZ", "DEED")
    {
        if (
            registry_ == address(0) || geoGate_ == address(0) || taxVault_ == address(0)
                || landlordRegistry_ == address(0) || floorManager_ == address(0) || usdg_ == address(0)
                || treasury_ == address(0)
        ) {
            revert InvalidAddress();
        }
        registry = ITickerRegistry(registry_);
        geoGate = IGeoGate(geoGate_);
        taxVault = ITaxVault(taxVault_);
        landlordRegistry = ILandlordRegistry(landlordRegistry_);
        floorManager = IFloorManager(floorManager_);
        usdg = IERC20(usdg_);
        treasury = treasury_;
    }

    function claim(bytes32 ticker, uint256 initialPrice, uint256 taxDeposit)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        _requireAllowed(msg.sender);
        ITickerRegistry.TickerConfig memory tickerConfig = registry.getTicker(ticker);
        if (!tickerConfig.active) revert InactiveTicker(ticker);
        if (claimedSupply[ticker] >= tickerConfig.deedSupply) revert SupplyExhausted(ticker);
        if (walletClaims[msg.sender] >= MAX_CLAIMS_PER_WALLET) revert ClaimLimitReached(msg.sender);
        _requireValidPrice(ticker, initialPrice);

        usdg.safeTransferFrom(msg.sender, treasury, CLAIM_FEE);

        tokenId = _nextTokenId++;
        uint16 serial = ++claimedSupply[ticker];
        ++walletClaims[msg.sender];
        _deeds[tokenId] = DeedData({
            ticker: ticker,
            serial: serial,
            price: initialPrice,
            pendingPrice: 0,
            pendingPriceBlock: 0
        });
        taxVault.openPosition(
            tokenId,
            msg.sender,
            tickerConfig.stockToken,
            tickerConfig.priceFeed,
            initialPrice,
            taxDeposit
        );
        _safeMint(msg.sender, tokenId);
        landlordRegistry.updateOwnership(ticker, address(0), msg.sender);

        emit Claimed(ticker, tokenId, msg.sender, serial, initialPrice);
    }

    function buy(uint256 tokenId, uint256 newPrice, uint256 taxDeposit) external nonReentrant {
        _requireAllowed(msg.sender);
        address seller = ownerOf(tokenId);
        if (seller == msg.sender) revert CannotBuyOwnDeed();
        DeedData storage data = _deeds[tokenId];
        _requireValidPrice(data.ticker, newPrice);
        _applyPendingPrice(data);
        _applyEnforcedFloor(tokenId, data);
        uint256 paidPrice = data.price;

        usdg.safeTransferFrom(msg.sender, seller, paidPrice);
        taxVault.replaceHolder(tokenId, msg.sender, newPrice, taxDeposit);

        _marketTransfer = true;
        _transfer(seller, msg.sender, tokenId);
        _marketTransfer = false;
        landlordRegistry.updateOwnership(data.ticker, seller, msg.sender);

        data.price = newPrice;
        data.pendingPrice = 0;
        data.pendingPriceBlock = 0;

        emit Bought(data.ticker, tokenId, seller, msg.sender, paidPrice, newPrice);
    }

    function setPrice(uint256 tokenId, uint256 newPrice) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotDeedOwner(msg.sender, tokenId);
        DeedData storage data = _deeds[tokenId];
        _requireValidPrice(data.ticker, newPrice);
        _applyPendingPrice(data);
        uint64 effectiveBlock = uint64(block.number + 1);
        data.pendingPrice = newPrice;
        data.pendingPriceBlock = effectiveBlock;
        taxVault.schedulePrice(tokenId, newPrice, effectiveBlock);

        emit RepriceScheduled(tokenId, data.price, newPrice, effectiveBlock);
    }

    function depositTax(uint256 tokenId, uint256 amount) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotDeedOwner(msg.sender, tokenId);
        taxVault.deposit(tokenId, msg.sender, amount);
    }

    function foreclose(uint256 tokenId) external nonReentrant {
        taxVault.accrue(tokenId);
        if (taxVault.balanceOf(tokenId) != 0) revert PositionHasRunway(tokenId);
        address formerOwner = ownerOf(tokenId);
        DeedData storage data = _deeds[tokenId];
        bytes32 ticker = data.ticker;
        taxVault.closeDepleted(tokenId);
        landlordRegistry.updateOwnership(ticker, formerOwner, address(0));
        _burn(tokenId);
        data.price = 0;
        data.pendingPrice = 0;
        data.pendingPriceBlock = 0;
        emit Foreclosed(ticker, tokenId, formerOwner);
    }

    function reclaim(uint256 tokenId, uint256 initialPrice, uint256 taxDeposit) external nonReentrant {
        _requireAllowed(msg.sender);
        if (_ownerOf(tokenId) != address(0) || _deeds[tokenId].serial == 0) revert DeedNotForeclosed(tokenId);
        if (walletClaims[msg.sender] >= MAX_CLAIMS_PER_WALLET) revert ClaimLimitReached(msg.sender);
        DeedData storage data = _deeds[tokenId];
        _requireValidPrice(data.ticker, initialPrice);
        ITickerRegistry.TickerConfig memory tickerConfig = registry.getTicker(data.ticker);
        if (!tickerConfig.active) revert InactiveTicker(data.ticker);
        usdg.safeTransferFrom(msg.sender, treasury, CLAIM_FEE);
        ++walletClaims[msg.sender];
        data.price = initialPrice;
        taxVault.openPosition(
            tokenId,
            msg.sender,
            tickerConfig.stockToken,
            tickerConfig.priceFeed,
            initialPrice,
            taxDeposit
        );
        _safeMint(msg.sender, tokenId);
        landlordRegistry.updateOwnership(data.ticker, address(0), msg.sender);
        emit Claimed(data.ticker, tokenId, msg.sender, data.serial, initialPrice);
    }

    function deedData(uint256 tokenId) external view returns (DeedData memory data) {
        ownerOf(tokenId);
        data = _deeds[tokenId];
        if (data.pendingPriceBlock != 0 && block.number >= data.pendingPriceBlock) {
            data.price = data.pendingPrice;
            data.pendingPrice = 0;
            data.pendingPriceBlock = 0;
        }
        uint256 enforcedFloor = _enforcedFloor(data.ticker);
        if (data.price < enforcedFloor) data.price = enforcedFloor;
    }

    function priceOf(uint256 tokenId) public view returns (uint256) {
        ownerOf(tokenId);
        DeedData storage data = _deeds[tokenId];
        uint256 price = data.pendingPriceBlock != 0 && block.number >= data.pendingPriceBlock ? data.pendingPrice : data.price;
        uint256 enforcedFloor = _enforcedFloor(data.ticker);
        return price < enforcedFloor ? enforcedFloor : price;
    }

    /// @notice Fully on-chain metadata and SVG art reflecting current Deed state.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address holder = ownerOf(tokenId);
        DeedData storage data = _deeds[tokenId];
        string memory tickerText = _tickerText(data.ticker);
        string memory serialText = uint256(data.serial).toString();
        string memory priceText = _priceText(priceOf(tokenId));
        (address landlord,,) = landlordRegistry.landlordOf(data.ticker);
        bool isLandlord = landlord == holder;

        string memory image = Base64.encode(bytes(string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900" viewBox="0 0 700 900">',
            '<rect width="700" height="900" rx="42" fill="#11140f"/>',
            '<path d="M0 650L700 410V900H0Z" fill="#dfff55"/>',
            '<circle cx="590" cy="120" r="76" fill="none" stroke="#dfff55" stroke-width="2" opacity=".55"/>',
            '<text x="54" y="86" fill="#dfff55" font-family="monospace" font-size="20" letter-spacing="7">DEEDZ</text>',
            '<text x="54" y="250" fill="#f6f4ec" font-family="Arial,sans-serif" font-size="112" font-weight="900">', tickerText, '</text>',
            '<text x="58" y="302" fill="#929a8c" font-family="monospace" font-size="22">ALWAYS FOR SALE</text>',
            '<text x="54" y="442" fill="#f6f4ec" font-family="Arial,sans-serif" font-size="64" font-weight="700">', priceText, '</text>',
            '<text x="58" y="482" fill="#929a8c" font-family="monospace" font-size="18">CURRENT PRICE IN USDG</text>',
            isLandlord
                ? '<rect x="52" y="532" width="184" height="48" rx="24" fill="#dfff55"/><text x="77" y="564" fill="#11140f" font-family="monospace" font-size="17" font-weight="700">LANDLORD</text>'
                : '<rect x="52" y="532" width="184" height="48" rx="24" fill="none" stroke="#596052"/><text x="76" y="564" fill="#929a8c" font-family="monospace" font-size="17">DEED HOLDER</text>',
            '<text x="54" y="724" fill="#11140f" font-family="monospace" font-size="18">SERIAL</text>',
            '<text x="54" y="786" fill="#11140f" font-family="Arial,sans-serif" font-size="64" font-weight="900">#', serialText, '</text>',
            '<text x="54" y="846" fill="#35402b" font-family="monospace" font-size="14">OWNER ', holder.toHexString(), '</text>',
            '</svg>'
        )));

        string memory json = Base64.encode(bytes(string.concat(
            '{"name":"DEEDZ ', tickerText, ' #', serialText,
            '","description":"An always-for-sale, Harberger-taxed Deed on Robinhood Chain.","image":"data:image/svg+xml;base64,',
            image,
            '","attributes":[{"trait_type":"Ticker","value":"', tickerText,
            '"},{"trait_type":"Serial","value":', serialText,
            '},{"trait_type":"Price USDG","value":"', priceText,
            '"},{"trait_type":"Landlord","value":"', isLandlord ? "Yes" : "No", '"}]}'
        )));
        return string.concat("data:application/json;base64,", json);
    }

    function enforceFloor(uint256 tokenId) external nonReentrant {
        ownerOf(tokenId);
        DeedData storage data = _deeds[tokenId];
        _applyPendingPrice(data);
        _applyEnforcedFloor(tokenId, data);
    }

    function approve(address, uint256) public pure override {
        revert ApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert ApprovalsDisabled();
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && !_marketTransfer) revert MarketTransferOnly();
        return super._update(to, tokenId, auth);
    }

    function _applyPendingPrice(DeedData storage data) private {
        if (data.pendingPriceBlock != 0 && block.number >= data.pendingPriceBlock) {
            data.price = data.pendingPrice;
            data.pendingPrice = 0;
            data.pendingPriceBlock = 0;
        }
    }

    function _requireAllowed(address account) private view {
        if (!geoGate.isAllowed(account)) revert IneligibleAccount(account);
    }

    function _applyEnforcedFloor(uint256 tokenId, DeedData storage data) private {
        uint256 enforcedFloor = _enforcedFloor(data.ticker);
        if (data.price >= enforcedFloor) return;
        uint256 oldPrice = data.price;
        data.price = enforcedFloor;
        data.pendingPrice = 0;
        data.pendingPriceBlock = 0;
        taxVault.schedulePrice(tokenId, enforcedFloor, uint64(block.number));
        emit FloorEnforced(tokenId, oldPrice, enforcedFloor);
    }

    function _enforcedFloor(bytes32 ticker) private view returns (uint256) {
        uint256 floor = floorManager.floorOf(ticker);
        uint256 raisedAt = floorManager.lastRaisedAt(ticker);
        return raisedAt != 0 && block.timestamp >= raisedAt + FLOOR_GRACE_PERIOD ? floor : MIN_PRICE;
    }

    function _requireValidPrice(bytes32 ticker, uint256 price) private view {
        uint256 floor = floorManager.floorOf(ticker);
        if (price < floor) revert PriceBelowFloor(price, floor);
    }

    function _tickerText(bytes32 ticker) private pure returns (string memory) {
        bytes memory output = new bytes(32);
        uint256 length;
        for (uint256 i; i < 32; ++i) {
            bytes1 character = ticker[i];
            if (character == 0) break;
            bool safe = (character >= 0x30 && character <= 0x39) || (character >= 0x41 && character <= 0x5A)
                || character == 0x2D || character == 0x2E || character == 0x5F;
            output[length++] = safe ? character : bytes1(0x3F);
        }
        bytes memory trimmed = new bytes(length);
        for (uint256 i; i < length; ++i) trimmed[i] = output[i];
        return string(trimmed);
    }

    function _priceText(uint256 priceUsd6) private pure returns (string memory) {
        uint256 cents = (priceUsd6 % 1e6) / 1e4;
        return string.concat(
            "$", (priceUsd6 / 1e6).toString(), ".", cents < 10 ? "0" : "", cents.toString()
        );
    }
}
