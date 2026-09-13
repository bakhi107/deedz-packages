// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockStockToken is ERC20 {
    constructor() ERC20("Mock Stock Token", "MSTOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
