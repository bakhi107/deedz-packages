// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RentTreasury} from "./RentTreasury.sol";
import {DeedArt} from "./DeedArt.sol";

interface IBurnableRent is IERC20 { function burnFrom(address account, uint256 amount) external; }
interface IFeeProcessor { function depositSaleFee() external payable; }

/// @notice The complete DEEDZ NFT lifecycle and always-for-sale market.
contract Deed is ERC721, Ownable, ReentrancyGuard {
    uint256 public constant LIGHT_COST = 25_000 ether;
    uint256 public constant MIN_PRICE_USD6 = 5e6;
    uint256 public constant SALE_FEE_BPS = 500;
    uint256 public constant BPS = 10_000;
    uint16 public constant SUPPLY_PER_CLAN = 250;

    enum State { Dormant, Lit, GoingDark, Dark }
    struct Data { bytes32 ticker; uint16 serial; uint256 priceUsd6; bool activated; }

    IBurnableRent public immutable rent;
    RentTreasury public immutable treasury;
    DeedArt public immutable art;
    address public feeProcessor;
    uint256 private _nextId = 1;
    bool private _marketTransfer;

    mapping(bytes32 => bool) public supportedTicker;
    mapping(bytes32 => uint16) public mintedSupply;
    mapping(uint256 => Data) private _data;
    mapping(address => uint256) public saleProceeds;

    event DormantMinted(uint256 indexed tokenId, bytes32 indexed ticker, address indexed holder, uint16 serial);
    event Lit(uint256 indexed tokenId, address indexed holder, uint256 priceUsd6, uint256 deposit);
    event RentToppedUp(uint256 indexed tokenId, uint256 amount);
    event PriceUpdated(uint256 indexed tokenId, uint256 priceUsd6);
    event Purchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 salePriceWei, uint256 feeWei);

    constructor(address owner_, address rent_, address payable treasury_, address feeProcessor_)
        ERC721("DEEDZ", "DEEDZ") Ownable(owner_)
    {
        require(owner_ != address(0) && rent_.code.length != 0 && treasury_.code.length != 0 && feeProcessor_ != address(0), "Invalid configuration");
        rent = IBurnableRent(rent_); treasury = RentTreasury(treasury_); feeProcessor = feeProcessor_;
        art = new DeedArt();
        bytes32[10] memory names = [bytes32("NVDA"),"TSLA","AAPL","MSFT","AMZN","META","GOOGL","NFLX","AMD","PLTR"];
        for (uint256 i; i < names.length; ++i) supportedTicker[names[i]] = true;
    }

    function mint(bytes32 ticker) external returns (uint256 id) {
        require(supportedTicker[ticker], "Unsupported clan");
        uint16 serial = mintedSupply[ticker] + 1; require(serial <= SUPPLY_PER_CLAN, "Clan sold out");
        mintedSupply[ticker] = serial; id = _nextId++;
        _data[id] = Data(ticker, serial, 0, false); _safeMint(msg.sender, id);
        emit DormantMinted(id, ticker, msg.sender, serial);
    }

    function light(uint256 id, uint256 priceUsd6) external payable nonReentrant {
        require(ownerOf(id) == msg.sender && (stateOf(id) == State.Dormant || stateOf(id) == State.Dark), "Not lightable");
        require(priceUsd6 >= MIN_PRICE_USD6, "Price below minimum");
        rent.burnFrom(msg.sender, LIGHT_COST);
        Data storage d = _data[id];
        if (!d.activated) { treasury.open{value: msg.value}(id, d.ticker, msg.sender, priceUsd6); d.activated = true; }
        else treasury.reopen{value: msg.value}(id, d.ticker, msg.sender, priceUsd6);
        d.priceUsd6 = priceUsd6;
        emit Lit(id, msg.sender, priceUsd6, msg.value);
    }

    function topUpRent(uint256 id) external payable nonReentrant {
        require(ownerOf(id) == msg.sender && stateOf(id) != State.Dark && stateOf(id) != State.Dormant, "Not active");
        treasury.topUp{value: msg.value}(id, msg.sender); emit RentToppedUp(id, msg.value);
    }

    function setPrice(uint256 id, uint256 priceUsd6) external nonReentrant {
        require(ownerOf(id) == msg.sender && stateOf(id) == State.Lit, "Not Lit");
        require(priceUsd6 >= MIN_PRICE_USD6, "Price below minimum");
        treasury.setPrice(id, priceUsd6); _data[id].priceUsd6 = priceUsd6; emit PriceUpdated(id, priceUsd6);
    }

    function buy(uint256 id, uint256 buyerPriceUsd6) external payable nonReentrant {
        State current = stateOf(id);
        require((current == State.Lit || current == State.GoingDark) && buyerPriceUsd6 >= MIN_PRICE_USD6, "Not purchasable");
        address seller = ownerOf(id); require(seller != msg.sender, "Already owner");
        Data storage d = _data[id];
        uint256 salePrice = treasury.usdToEth(d.priceUsd6);
        uint256 fee = salePrice * SALE_FEE_BPS / BPS;
        uint256 newDeposit = treasury.dailyRentWei(buyerPriceUsd6) * 7;
        require(msg.value >= salePrice + fee + newDeposit, "Insufficient payment");
        saleProceeds[seller] += salePrice;
        treasury.replace{value: newDeposit}(id, seller, msg.sender, buyerPriceUsd6);
        IFeeProcessor(feeProcessor).depositSaleFee{value: fee}();
        uint256 refund = msg.value - salePrice - fee - newDeposit;
        d.priceUsd6 = buyerPriceUsd6; _marketTransfer = true; _transfer(seller, msg.sender, id); _marketTransfer = false;
        if (refund != 0) { (bool ok,) = payable(msg.sender).call{value: refund}(""); require(ok, "Refund failed"); }
        emit Purchased(id, seller, msg.sender, salePrice, fee);
    }

    function claimSaleProceeds(address payable recipient) external nonReentrant returns (uint256 amount) {
        require(recipient != address(0), "Invalid recipient"); amount = saleProceeds[msg.sender]; saleProceeds[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}(""); require(ok, "Transfer failed");
    }

    function stateOf(uint256 id) public view returns (State) {
        ownerOf(id); if (!_data[id].activated) return State.Dormant;
        if (treasury.isLit(id)) return State.Lit;
        if (treasury.isGoingDark(id)) return State.GoingDark;
        return State.Dark;
    }

    function deedData(uint256 id) external view returns (Data memory) { ownerOf(id); return _data[id]; }
    function totalMinted() external view returns (uint256) { return _nextId - 1; }
    function tokenURI(uint256 id) public view override returns (string memory) {
        ownerOf(id); Data memory d = _data[id]; State s = stateOf(id); (uint256 balance,,) = treasury.preview(id);
        uint256 daily = d.activated ? treasury.dailyRate(id) : 0;
        uint256 runway = daily == 0 ? 0 : balance * 1e6 / daily;
        return art.render(DeedArt.Card(d.ticker, d.serial, uint8(s), d.priceUsd6, runway, false, false, 0));
    }

    function setFeeProcessor(address value) external onlyOwner { require(value.code.length != 0, "Invalid processor"); feeProcessor = value; }

    function _update(address to, uint256 id, address auth) internal override returns (address from) {
        from = _ownerOf(id);
        if (from != address(0) && to != address(0) && stateOf(id) != State.Dormant && stateOf(id) != State.Dark && !_marketTransfer) revert("Active DEEDZ must be purchased");
        return super._update(to, id, auth);
    }
}
