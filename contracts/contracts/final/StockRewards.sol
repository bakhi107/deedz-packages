// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Custodies stock-token reward batches. Eligibility is snapshotted by the authorized keeper.
contract StockRewards is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Batch { bytes32 ticker; IERC20 token; bytes32 root; uint256 funded; uint256 claimed; uint64 createdAt; }

    mapping(address => bool) public processor;
    Batch[] public batches;
    mapping(uint256 => mapping(uint256 => bool)) public tokenClaimed;
    mapping(bytes32 => IERC20) public stockToken;
    // Merkle leaves commit equal-share indices instead of a predicted swap output.
    mapping(uint256 => uint256) public batchSize;
    mapping(uint256 => mapping(uint256 => bool)) public shareClaimed;

    struct Registration { uint256 tokenId; address account; uint256 amount; bytes32[] proof; }
    mapping(address => mapping(uint256 => uint256)) public claimableStock;
    mapping(address => mapping(uint256 => uint256)) public claimedStock;
    mapping(uint256 => bytes32) public rewardTicker;
    mapping(address => uint256[]) private _rewardIds;
    mapping(address => mapping(uint256 => bool)) private _knownReward;

    event RewardCredited(uint256 indexed batchId, uint256 indexed tokenId, address indexed account, uint256 amount);
    event StockRewardsClaimed(uint256 indexed tokenId, address indexed account, bytes32 indexed ticker, uint256 amount);
    event ProcessorUpdated(address indexed processor);
    event StockConfigured(bytes32 indexed ticker, address indexed token);
    event BatchCreated(uint256 indexed batchId, bytes32 indexed ticker, bytes32 root, uint256 amount);
    event RewardClaimed(uint256 indexed batchId, uint256 indexed tokenId, address indexed account, uint256 amount);

    modifier onlyProcessor() { require(processor[msg.sender], "Only processor"); _; }

    constructor(address owner_, address processor_) Ownable(owner_) {
        require(owner_ != address(0) && processor_ != address(0), "Invalid address");
        processor[processor_] = true;
    }

    function setProcessor(address value, bool allowed) external onlyOwner {
        require(value != address(0), "Invalid processor");
        processor[value] = allowed;
        emit ProcessorUpdated(value);
    }

    function configureStock(bytes32 ticker, address token) external onlyOwner {
        require(ticker != bytes32(0) && token.code.length != 0 && address(stockToken[ticker]) == address(0), "Invalid stock");
        stockToken[ticker] = IERC20(token);
        emit StockConfigured(ticker, token);
    }

    function createBatch(bytes32 ticker, bytes32 root, uint256 amount) external onlyProcessor nonReentrant returns (uint256 id) {
        IERC20 token = stockToken[ticker];
        require(address(token) != address(0) && root != bytes32(0) && amount != 0, "Invalid batch");
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) - beforeBalance == amount, "Inexact funding");
        id = batches.length;
        batches.push(Batch(ticker, token, root, amount, 0, uint64(block.timestamp)));
        emit BatchCreated(id, ticker, root, amount);
    }

    function createShareBatch(bytes32 ticker, bytes32 root, uint256 amount, uint256 size) external onlyProcessor nonReentrant returns (uint256 id) {
        require(size > 0 && size <= 250, "Invalid holder count");
        IERC20 token = stockToken[ticker];
        require(address(token) != address(0) && root != bytes32(0) && amount >= size, "Invalid batch");
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) - beforeBalance == amount, "Inexact funding");
        id = batches.length; batchSize[id] = size;
        batches.push(Batch(ticker, token, root, amount, 0, uint64(block.timestamp)));
        emit BatchCreated(id, ticker, root, amount);
    }

    function shareAmount(uint256 batchId, uint256 index) public view returns (uint256) {
        uint256 size = batchSize[batchId]; require(size != 0 && index < size, "Invalid share");
        uint256 funded = batches[batchId].funded;
        // Exact partition, including integer dust. Each holder differs by at most one base unit.
        return funded * (index + 1) / size - funded * index / size;
    }

    /// @notice Register bounded, proven entitlements without sending tokens to holders.
    /// Anyone may relay a proof; only its snapshotted account receives the credit.
    function registerClaims(uint256 batchId, Registration[] calldata entries) external nonReentrant {
        require(entries.length > 0 && entries.length <= 50, "Invalid registration size");
        Batch storage batch = batches[batchId];
        for (uint256 i; i < entries.length; ++i) {
            Registration calldata entry = entries[i];
            require(entry.account != address(0), "Invalid account");
            _verify(batchId, entry.tokenId, entry.account, entry.amount, entry.proof);
            // Idempotent recovery after a keeper restart or a direct legacy claim.
            if (tokenClaimed[batchId][entry.tokenId]) continue;
            uint256 amount = _consume(batchId, entry.tokenId, entry.amount);
            require(rewardTicker[entry.tokenId] == bytes32(0) || rewardTicker[entry.tokenId] == batch.ticker, "Clan mismatch");
            rewardTicker[entry.tokenId] = batch.ticker;
            if (!_knownReward[entry.account][entry.tokenId]) {
                _knownReward[entry.account][entry.tokenId] = true;
                _rewardIds[entry.account].push(entry.tokenId);
            }
            claimableStock[entry.account][entry.tokenId] += amount;
            emit RewardCredited(batchId, entry.tokenId, entry.account, amount);
        }
    }

    /// @notice Claim this wallet's recorded stock rewards using only the NFT number.
    /// A later NFT transfer does not transfer the former holder's earned rewards.
    function claimStockRewards(uint256 tokenId) external nonReentrant returns (uint256 amount) {
        amount = claimableStock[msg.sender][tokenId];
        require(amount != 0, "No stock rewards");
        claimableStock[msg.sender][tokenId] = 0;
        claimedStock[msg.sender][tokenId] += amount;
        bytes32 ticker = rewardTicker[tokenId];
        stockToken[ticker].safeTransfer(msg.sender, amount);
        emit StockRewardsClaimed(tokenId, msg.sender, ticker, amount);
    }

    function claimInterfaceVersion() external pure returns (uint256) { return 1; }
    function rewardTokenCount(address account) external view returns (uint256) { return _rewardIds[account].length; }
    function rewardTokenIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        require(limit > 0 && limit <= 50, "Invalid page size");
        uint256 length = _rewardIds[account].length;
        uint256 size = offset >= length ? 0 : (length - offset < limit ? length - offset : limit);
        ids = new uint256[](size);
        for (uint256 i; i < size; ++i) ids[i] = _rewardIds[account][offset + i];
    }

    // Compatibility/recovery path. Both entrypoints consume the same entitlement.
    function claim(uint256 batchId, uint256 tokenId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _verify(batchId, tokenId, msg.sender, amount, proof);
        amount = _consume(batchId, tokenId, amount);
        batches[batchId].token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(batchId, tokenId, msg.sender, amount);
    }

    function _verify(uint256 batchId, uint256 tokenId, address account, uint256 amount, bytes32[] calldata proof) private view {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(batchId, tokenId, account, amount))));
        require(MerkleProof.verifyCalldata(proof, batches[batchId].root, leaf), "Invalid proof");
    }

    // Batch.claimed tracks reserved plus directly paid units. Credits remain in custody until withdrawn.
    function _consume(uint256 batchId, uint256 tokenId, uint256 amount) private returns (uint256) {
        Batch storage batch = batches[batchId];
        require(!tokenClaimed[batchId][tokenId], "Already claimed");
        tokenClaimed[batchId][tokenId] = true;
        if (batchSize[batchId] != 0) {
            require(!shareClaimed[batchId][amount], "Share already claimed");
            shareClaimed[batchId][amount] = true;
            amount = shareAmount(batchId, amount);
        }
        batch.claimed += amount;
        require(batch.claimed <= batch.funded, "Over-allocated batch");
        return amount;
    }

    function batchCount() external view returns (uint256) { return batches.length; }
}
