// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Fixed-supply RENT. There is deliberately no mint function.
contract RentToken is ERC20, ERC20Burnable {
    uint256 public constant SUPPLY = 1_000_000_000 ether;

    constructor(address receiver) ERC20("DEEDZ Rent", "RENT") {
        require(receiver != address(0), "Invalid receiver");
        _mint(receiver, SUPPLY);
    }
}
