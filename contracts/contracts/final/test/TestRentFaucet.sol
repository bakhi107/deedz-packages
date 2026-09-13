// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TestRentFaucet {
    using SafeERC20 for IERC20;
    uint256 public constant CLAIM_AMOUNT = 50_000 ether;
    uint256 public constant MAX_CLAIMS = 2;
    IERC20 public immutable rent;
    mapping(address => uint256) public claims;
    constructor(address rent_) { require(rent_.code.length != 0, "Invalid RENT"); rent = IERC20(rent_); }
    function claim() external {
        require(claims[msg.sender] < MAX_CLAIMS, "Claim limit reached");
        claims[msg.sender] += 1; rent.safeTransfer(msg.sender, CLAIM_AMOUNT);
    }
}
