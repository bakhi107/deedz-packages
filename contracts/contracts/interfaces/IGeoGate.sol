// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IGeoGate {
    function isAllowed(address account) external view returns (bool);
}

