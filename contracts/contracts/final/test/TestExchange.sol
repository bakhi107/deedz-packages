// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IStockSwap} from "../interfaces/IStockSwap.sol";

contract TestExchange is Ownable, IStockSwap {
    using SafeERC20 for IERC20;
    IERC20 public immutable rent;
    mapping(bytes32 => IERC20) public stock;
    mapping(bytes32 => uint256) public stockPerEth;
    uint256 public rentPerEth;

    constructor(address owner_, address rent_) Ownable(owner_) { require(rent_.code.length != 0, "Invalid RENT"); rent = IERC20(rent_); }
    function configureStock(bytes32 ticker, address token, uint256 rate) external onlyOwner {
        require(token.code.length != 0 && rate != 0, "Invalid stock"); stock[ticker] = IERC20(token); stockPerEth[ticker] = rate;
    }
    function setRentRate(uint256 rate) external onlyOwner { require(rate != 0, "Invalid rate"); rentPerEth = rate; }
    function buyStock(bytes32 ticker, address recipient, uint256 minimumOut) external payable returns (uint256 amountOut) {
        amountOut = msg.value * stockPerEth[ticker] / 1 ether; require(amountOut >= minimumOut && amountOut != 0, "Insufficient output");
        stock[ticker].safeTransfer(recipient, amountOut);
    }
    function buyRent(address recipient, uint256 minimumOut) external payable returns (uint256 amountOut) {
        amountOut = msg.value * rentPerEth / 1 ether; require(amountOut >= minimumOut && amountOut != 0, "Insufficient output");
        rent.safeTransfer(recipient, amountOut);
    }
    function claimEth(address payable recipient) external onlyOwner { (bool ok,) = recipient.call{value: address(this).balance}(""); require(ok, "Transfer failed"); }
}
