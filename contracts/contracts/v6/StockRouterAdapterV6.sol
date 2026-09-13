// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWrappedEthV6 is IERC20 { function deposit() external payable; }
interface IV3SwapRouter02V6 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
/// @notice Adapter for a verified SwapRouter02-compatible existing venue. No arbitrary calldata,
/// pools, recipient substitution, or mutable router/token addresses.
contract StockRouterAdapterV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable router;
    IWrappedEthV6 public immutable weth;
    IERC20 public immutable stock;
    uint24 public immutable fee;
    constructor(address router_, address weth_, address stock_, uint24 fee_) {
        require(router_.code.length != 0 && weth_.code.length != 0 && stock_.code.length != 0, "Contracts required");
        router = router_; weth = IWrappedEthV6(weth_); stock = IERC20(stock_); fee = fee_;
    }
    function swapExactEthForToken(address token, uint256 minimum, uint256 deadline, bytes calldata routeData)
        external payable nonReentrant returns (uint256 amount) {
        require(token == address(stock) && routeData.length == 0 && msg.value != 0 && minimum != 0, "Invalid route");
        require(deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "Invalid deadline");
        weth.deposit{value: msg.value}();
        IERC20(address(weth)).forceApprove(router, msg.value);
        uint256 beforeBalance = stock.balanceOf(address(this));
        uint256 reported = IV3SwapRouter02V6(router).exactInputSingle(IV3SwapRouter02V6.ExactInputSingleParams(
            address(weth), address(stock), fee, address(this), msg.value, minimum, 0));
        IERC20(address(weth)).forceApprove(router, 0);
        amount = stock.balanceOf(address(this)) - beforeBalance;
        require(amount >= minimum && reported == amount, "Inexact swap");
        uint256 recipientBefore = stock.balanceOf(msg.sender);
        stock.safeTransfer(msg.sender, amount);
        require(stock.balanceOf(msg.sender) - recipientBefore == amount, "Restricted or inexact token");
    }
}
