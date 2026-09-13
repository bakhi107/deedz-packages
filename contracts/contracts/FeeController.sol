// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ILandlordRegistry} from "./interfaces/ILandlordRegistry.sol";

/// @title FeeController
/// @notice Allows the current Landlord to set a ticker's total swap fee within launch bounds.
contract FeeController {
    uint24 public constant DEFAULT_FEE_BPS = 5;
    uint24 public constant MIN_FEE_BPS = 1;
    uint24 public constant MAX_FEE_BPS = 30;
    uint256 public constant CHANGE_COOLDOWN = 1 hours;

    error InvalidAddress();
    error NotLandlord(bytes32 ticker, address caller);
    error FeeOutOfRange(uint256 feeBps);
    error FeeChangeTooSoon(uint256 availableAt);

    struct FeeState {
        uint24 feeBps;
        uint64 lastChangedAt;
    }

    ILandlordRegistry public immutable landlordRegistry;
    mapping(bytes32 ticker => FeeState state) private _fees;

    event FeeSet(bytes32 indexed ticker, address indexed landlord, uint256 feeBps);

    constructor(address landlordRegistry_) {
        if (landlordRegistry_ == address(0)) revert InvalidAddress();
        landlordRegistry = ILandlordRegistry(landlordRegistry_);
    }

    function setFee(bytes32 ticker, uint24 newFeeBps) external {
        (address landlord,,) = landlordRegistry.landlordOf(ticker);
        if (landlord != msg.sender) revert NotLandlord(ticker, msg.sender);
        if (newFeeBps < MIN_FEE_BPS || newFeeBps > MAX_FEE_BPS) revert FeeOutOfRange(newFeeBps);

        FeeState storage state = _fees[ticker];
        uint256 availableAt = uint256(state.lastChangedAt) + CHANGE_COOLDOWN;
        if (state.lastChangedAt != 0 && block.timestamp < availableAt) revert FeeChangeTooSoon(availableAt);
        state.feeBps = newFeeBps;
        state.lastChangedAt = uint64(block.timestamp);
        emit FeeSet(ticker, msg.sender, newFeeBps);
    }

    function feeBps(bytes32 ticker) external view returns (uint24) {
        uint24 configured = _fees[ticker].feeBps;
        return configured == 0 ? DEFAULT_FEE_BPS : configured;
    }
}
