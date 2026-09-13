// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.26;
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only wallet: deliberately rejects ordinary ETH receipts.
contract RejectingHolderV6 {
    address public immutable owner;
    constructor(address owner_) { owner = owner_; }
    function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory result) {
        require(msg.sender == owner, "Only owner");
        (bool ok, bytes memory output) = target.call{value: value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(output, 32), mload(output)) }
        return output;
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC721Received.selector; }
    receive() external payable { revert("ETH refused"); }
}

/// @dev Test-only EntryPoint boundary harness, never a deployed ERC-4337 dependency.
contract PaymasterEntryPointHarnessV6 {
    bytes public lastContext;
    uint256 public validationData;
    function supportsInterface(bytes4) external pure returns (bool) { return true; }
    function validate(address paymaster, PackedUserOperation calldata op, uint256 maximum) external {
        (lastContext, validationData) = IPaymaster(paymaster).validatePaymasterUserOp(op, bytes32(0), maximum);
    }
    function finish(address paymaster, bool success, uint256 cost) external {
        IPaymaster(paymaster).postOp(success ? IPaymaster.PostOpMode.opSucceeded : IPaymaster.PostOpMode.opReverted, lastContext, cost, 1);
    }
}

interface IRevenueLockerHarnessV6 { function notifyRevenue(uint256 grossRevenue) external payable; }
contract RevenueSourceHarnessV6 {
    function notify(address locker, uint256 grossRevenue) external payable {
        IRevenueLockerHarnessV6(locker).notifyRevenue{value: msg.value}(grossRevenue);
    }
}

contract WrappedEthHarnessV6 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
}

interface IMintableStockHarnessV6 { function mint(address recipient, uint256 amount) external; }
contract SwapRouterHarnessV6 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    address public immutable weth;
    address public immutable stock;
    constructor(address weth_, address stock_) { weth = weth_; stock = stock_; }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        require(params.tokenIn == weth && params.tokenOut == stock && params.recipient != address(0), "Bad route");
        IERC20(weth).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn * 2;
        require(amountOut >= params.amountOutMinimum, "Slippage");
        IMintableStockHarnessV6(stock).mint(params.recipient, amountOut);
    }
}
