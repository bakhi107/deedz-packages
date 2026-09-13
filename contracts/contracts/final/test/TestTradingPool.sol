// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFeeSink { function depositTradingFees() external payable; }

/// @notice Testnet swap surface with the protocol's exact 5% ETH-denominated fee.
contract TestTradingPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant FEE_BPS = 500;
    uint256 public constant BPS = 10_000;
    IERC20 public immutable rent;
    IFeeSink public immutable feeProcessor;
    uint256 public rentPerEth;

    event Swapped(address indexed account, bool ethForRent, uint256 input, uint256 output, uint256 ethFee);
    constructor(address owner_, address rent_, address processor_, uint256 rate) Ownable(owner_) {
        require(rent_.code.length != 0 && processor_.code.length != 0 && rate != 0, "Invalid configuration");
        rent = IERC20(rent_); feeProcessor = IFeeSink(processor_); rentPerEth = rate;
    }
    receive() external payable {}
    function setRate(uint256 rate) external onlyOwner { require(rate != 0, "Invalid rate"); rentPerEth = rate; }
    function swapEthForRent(uint256 minimumOut) external payable nonReentrant returns (uint256 output) {
        uint256 fee = msg.value * FEE_BPS / BPS; uint256 net = msg.value - fee;
        output = net * rentPerEth / 1 ether; require(output >= minimumOut && output != 0, "Insufficient output");
        feeProcessor.depositTradingFees{value: fee}(); rent.safeTransfer(msg.sender, output);
        emit Swapped(msg.sender, true, msg.value, output, fee);
    }
    function swapRentForEth(uint256 rentIn, uint256 minimumOut) external nonReentrant returns (uint256 output) {
        uint256 gross = rentIn * 1 ether / rentPerEth; uint256 fee = gross * FEE_BPS / BPS; output = gross - fee;
        require(output >= minimumOut && output != 0 && address(this).balance >= gross, "Insufficient output");
        rent.safeTransferFrom(msg.sender, address(this), rentIn); feeProcessor.depositTradingFees{value: fee}();
        (bool ok,) = payable(msg.sender).call{value: output}(""); require(ok, "Transfer failed");
        emit Swapped(msg.sender, false, rentIn, output, fee);
    }
}
