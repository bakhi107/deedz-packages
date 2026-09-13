// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MockTradingFeeSource {
    error TransferFailed();

    function claimBucket() external returns (uint256 amount) {
        amount = address(this).balance;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {}
}
