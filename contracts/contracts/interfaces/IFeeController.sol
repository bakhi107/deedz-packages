// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFeeController {
    function feeBps(bytes32 ticker) external view returns (uint24);
}
