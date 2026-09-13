// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DeedV6} from "./DeedV6.sol";
import {StockRewardsV6} from "./StockRewardsV6.sol";

contract ThronePoolV6 is Ownable, ReentrancyGuard {
    DeedV6 public deed;
    StockRewardsV6 public immutable rewards;
    bytes32[10] public tickers = [bytes32("NVDA"), "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "NFLX", "COIN", "AMD"];
    mapping(bytes32 => uint256) public tokenId;
    mapping(bytes32 => uint256) public pendingEth;
    uint256 public newFunds;
    uint256 public dust;
    constructor(address governor, address rewards_) Ownable(governor) { rewards = StockRewardsV6(rewards_); }
    function configure(address deed_) external onlyOwner {
        require(address(deed) == address(0) && deed_.code.length != 0, "Configuration frozen");
        deed = DeedV6(deed_);
    }
    function register(bytes32 ticker, uint256 id) external {
        require(msg.sender == address(deed) && tokenId[ticker] == 0, "Only deed"); tokenId[ticker] = id;
    }
    function checkpoint() external nonReentrant {
        uint256 funds = newFunds + dust; newFunds = 0;
        uint256 share = funds / 10; dust = funds % 10;
        for (uint256 i; i < 10; ++i) {
            bytes32 ticker = tickers[i];
            uint256 amount = pendingEth[ticker] + share;
            uint256 id = tokenId[ticker];
            if (id != 0 && deed.deedData(id).lit && amount != 0) {
                pendingEth[ticker] = 0;
                rewards.queueDirectReward{value: amount}(ticker, deed.ownerOf(id));
            } else pendingEth[ticker] = amount;
        }
    }
    receive() external payable { newFunds += msg.value; }
}

/// @notice One sealed week-two auction per ticker. Bids and refunds use ETH; proceeds go only to LP.
/// The winner receives the permanent Throne flag as a Dark Deed and lights it under normal burn/rent rules.
contract ThroneAuctionV6 is Ownable, ReentrancyGuard {
    struct Auction { uint64 start; uint64 end; address bidder; uint256 bid; bool settled; }
    DeedV6 public immutable deed;
    address payable public immutable liquidity;
    bool public enabled;
    mapping(bytes32 => Auction) public auctions;
    mapping(address => uint256) public refunds;
    event Bid(bytes32 indexed ticker, address indexed bidder, uint256 amount, uint256 end);
    event Settled(bytes32 indexed ticker, address indexed winner, uint256 tokenId, uint256 proceeds);
    constructor(address governor, address deed_, address payable lp) Ownable(governor) {
        require(lp.code.length != 0, "Liquidity contract required");
        deed = DeedV6(deed_); liquidity = lp;
    }
    function enable() external onlyOwner {
        require(block.timestamp >= uint256(deed.launchedAt()) + 8 days, "Week two only"); enabled = true;
    }
    function schedule(bytes32 ticker, uint64 start, uint64 end) external onlyOwner {
        require(deed.supportedTicker(ticker) && auctions[ticker].end == 0 && start >= uint256(deed.launchedAt()) + 8 days
            && start >= block.timestamp && end > start && end <= start + 7 days, "Invalid auction");
        auctions[ticker] = Auction(start, end, address(0), 0, false);
    }
    function bid(bytes32 ticker) external payable nonReentrant {
        Auction storage a = auctions[ticker];
        require(enabled && block.timestamp >= a.start && block.timestamp < a.end, "Auction unavailable");
        require(msg.value > a.bid && (a.bid == 0 || msg.value >= a.bid + (a.bid + 99) / 100), "Raise by one percent");
        refunds[a.bidder] += a.bid;
        a.bidder = msg.sender; a.bid = msg.value;
        emit Bid(ticker, msg.sender, msg.value, a.end);
    }
    function settle(bytes32 ticker) external nonReentrant {
        Auction storage a = auctions[ticker];
        require(enabled && a.end != 0 && block.timestamp >= a.end && !a.settled && a.bidder != address(0), "Cannot settle");
        a.settled = true;
        uint256 id = deed.mintThrone(ticker, a.bidder);
        (bool ok,) = liquidity.call{value: a.bid}(""); require(ok, "LP funding failed");
        emit Settled(ticker, a.bidder, id, a.bid);
    }
    function claimRefund(address payable recipient) external nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        uint256 amount = refunds[msg.sender]; refunds[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}(""); require(ok, "Refund failed");
    }
}
