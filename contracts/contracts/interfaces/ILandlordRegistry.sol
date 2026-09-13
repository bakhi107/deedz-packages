// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ILandlordRegistry {
    function updateOwnership(bytes32 ticker, address from, address to) external;
    function landlordOf(bytes32 ticker) external view returns (address landlord, uint256 deedCount, uint256 shareBps);
}
