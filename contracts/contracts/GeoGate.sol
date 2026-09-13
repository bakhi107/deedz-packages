// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GeoGate
/// @notice Stores expiring eligibility attestations issued by the protocol's compliance service.
contract GeoGate is Ownable {
    error InvalidAccount();
    error InvalidExpiry();

    mapping(address account => uint64 validUntil) public eligibilityExpiry;

    event EligibilitySet(address indexed account, uint64 validUntil);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setEligibility(address account, uint64 validUntil) external onlyOwner {
        if (account == address(0)) revert InvalidAccount();
        if (validUntil <= block.timestamp) revert InvalidExpiry();
        eligibilityExpiry[account] = validUntil;
        emit EligibilitySet(account, validUntil);
    }

    function revokeEligibility(address account) external onlyOwner {
        eligibilityExpiry[account] = 0;
        emit EligibilitySet(account, 0);
    }

    function isAllowed(address account) external view returns (bool) {
        return eligibilityExpiry[account] > block.timestamp;
    }
}

