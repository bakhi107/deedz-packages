// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IFeeBucketRouter {
    function claimBucket() external returns (uint256 amount);
}

/// @notice Replaceable development receiver for one fee bucket. Production modules replace these sinks.
contract FeeBucketReceiverV6 is Ownable {
    error TransferFailed();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function pull(address router) external onlyOwner returns (uint256 amount) {
        amount = IFeeBucketRouter(router).claimBucket();
    }

    function withdraw(address payable receiver, uint256 amount) external onlyOwner {
        (bool success,) = receiver.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {}
}
