// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only RENT dispenser. Never deploy or configure this on mainnet.
contract TestRentFaucetV6 is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant CLAIM_AMOUNT = 50_000 ether;
    uint256 public constant COOLDOWN = 1 days;
    uint256 public constant MAX_CLAIMS = 2;
    IERC20 public immutable rent;
    mapping(address => uint256) public lastClaimAt;
    mapping(address => uint256) public claims;

    event RentClaimed(address indexed wallet, uint256 amount, uint256 nextClaimAt);

    constructor(address rent_, address owner_) Ownable(owner_) {
        require(rent_.code.length != 0, "RENT required");
        rent = IERC20(rent_);
    }

    function nextClaimAt(address wallet) public view returns (uint256) {
        uint256 last = lastClaimAt[wallet];
        return last == 0 ? 0 : last + COOLDOWN;
    }

    function claim() external {
        require(claims[msg.sender] < MAX_CLAIMS, "Claim limit reached");
        require(block.timestamp >= nextClaimAt(msg.sender), "Faucet cooldown");
        claims[msg.sender] += 1;
        lastClaimAt[msg.sender] = block.timestamp;
        rent.safeTransfer(msg.sender, CLAIM_AMOUNT);
        emit RentClaimed(msg.sender, CLAIM_AMOUNT, block.timestamp + COOLDOWN);
    }

    function withdraw(address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Invalid recipient");
        rent.safeTransfer(recipient, amount);
    }
}
