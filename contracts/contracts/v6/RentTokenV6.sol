// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title RENT
/// @notice Fixed-supply v6 protocol token. It has no transfer tax and cannot be minted again.
contract RentTokenV6 is ERC20, ERC20Burnable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    constructor(address allocationReceiver) ERC20("DEEDZ Rent", "RENT") {
        _mint(allocationReceiver, MAX_SUPPLY);
    }
}
