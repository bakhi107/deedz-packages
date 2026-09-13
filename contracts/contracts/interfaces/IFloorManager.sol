// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFloorManager {
    function floorOf(bytes32 ticker) external view returns (uint256);
    function lastRaisedAt(bytes32 ticker) external view returns (uint256);
}
