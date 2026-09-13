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

    function claim(uint256 batchId, uint256 tokenId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Batch storage batch = batches[batchId];
        require(!tokenClaimed[batchId][tokenId], "Already claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(batchId, tokenId, msg.sender, amount))));
        require(MerkleProof.verifyCalldata(proof, batch.root, leaf), "Invalid proof");
        tokenClaimed[batchId][tokenId] = true;
        batch.claimed += amount;
        require(batch.claimed <= batch.funded, "Over-allocated batch");
        batch.token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(batchId, tokenId, msg.sender, amount);
    }

    function batchCount() external view returns (uint256) { return batches.length; }
}
