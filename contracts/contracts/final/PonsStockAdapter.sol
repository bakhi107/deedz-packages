// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStockSwap} from "./interfaces/IStockSwap.sol";

interface IPonsV3Factory { function getPool(address,address,uint24) external view returns(address); }
interface IPonsV3Pool {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function fee() external view returns(uint24);
    function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256);
}
interface IWETH is IERC20 { function deposit() external payable; function withdraw(uint256) external; }
interface IRentBuyRouter { function swapExactInputEthForRent(uint256,uint256) external payable returns(uint256); }

/// @notice Executes against Pons' verified V3 venue on Robinhood. Routes may use
/// WETH/stock directly or WETH/USDG/stock. Only actual received units are returned.
/// Price bounds are supplied by the trusted keeper, as in Cycle; they are not an oracle.
contract PonsStockAdapter is Ownable, ReentrancyGuard, IStockSwap {
    using SafeERC20 for IERC20;
    struct Route { address token; address pool; bool viaUSDG; }
    IPonsV3Factory public immutable factory;
    IWETH public immutable weth;
    IERC20 public immutable usdg;
    IERC20 public immutable rent;
    address public fundingPool;
    address public rentRouter;
    mapping(bytes32 => Route) public routes;
    mapping(address => bool) public buyer;
    address private callbackPool;
    address private callbackToken;
    uint256 private callbackAmount;

    event RouteConfigured(bytes32 indexed ticker,address indexed token,address pool,bool viaUSDG);
    event StockPurchased(bytes32 indexed ticker,address indexed recipient,uint256 ethIn,uint256 stockOut);
    event StockSold(bytes32 indexed ticker,address indexed seller,uint256 stockIn,uint256 ethOut);
    event BuyerUpdated(address indexed buyer,bool allowed);

    constructor(address owner_,address factory_,address weth_,address usdg_,address rent_) Ownable(owner_) {
        require(factory_.code.length>0 && weth_.code.length>0 && usdg_.code.length>0 && rent_.code.length>0,"Invalid dependencies");
        factory=IPonsV3Factory(factory_); weth=IWETH(weth_); usdg=IERC20(usdg_); rent=IERC20(rent_);
    }
    receive() external payable { require(msg.sender==address(weth),"Only WETH"); }
    function setBuyer(address account,bool allowed) external onlyOwner {
        require(account!=address(0),"Invalid buyer"); buyer[account]=allowed; emit BuyerUpdated(account,allowed);
    }
    function setFundingPool(address pool) external onlyOwner { _validate(pool,address(weth),address(usdg)); fundingPool=pool; }
    function setRentRouter(address router) external onlyOwner { require(router.code.length>0,"Invalid router"); rentRouter=router; }
    function configureStock(bytes32 ticker,address token,address pool,bool viaUSDG) external onlyOwner {
        require(ticker!=bytes32(0) && token.code.length>0 && token!=address(weth) && token!=address(usdg),"Invalid stock");
        require(routes[ticker].token==address(0) || routes[ticker].token==token,"Stock identity frozen");
        _validate(pool,token,viaUSDG?address(usdg):address(weth));
        routes[ticker]=Route(token,pool,viaUSDG); emit RouteConfigured(ticker,token,pool,viaUSDG);
    }
    function buyStock(bytes32 ticker,address recipient,uint256 minimumOut) external payable nonReentrant returns(uint256 amountOut) {
        require(buyer[msg.sender] && recipient==msg.sender,"Unauthorized buyer");
        require(msg.value>0 && minimumOut>0,"Invalid bounds");
        Route memory route=routes[ticker]; require(route.token!=address(0),"Stock unavailable");
        weth.deposit{value:msg.value}(); uint256 input=msg.value;
        if(route.viaUSDG) input=_swap(fundingPool,address(weth),address(usdg),input);
        amountOut=_swap(route.pool,route.viaUSDG?address(usdg):address(weth),route.token,input);
        require(amountOut>=minimumOut,"Stock slippage");
        _deliver(IERC20(route.token),recipient,amountOut);
        emit StockPurchased(ticker,recipient,msg.value,amountOut);
    }
    /// @notice Holders can sell their own claimed tokens; protocol reward custody is never spent.
    function sellStock(bytes32 ticker,uint256 amount,uint256 minimumETH,uint256 deadline) external nonReentrant returns(uint256 ethOut) {
        require(amount>0 && minimumETH>0 && block.timestamp<=deadline && deadline<=block.timestamp+120,"Invalid bounds");
        Route memory route=routes[ticker]; require(route.token!=address(0),"Stock unavailable");
        IERC20 token=IERC20(route.token); uint256 beforeBalance=token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender,address(this),amount);
        require(token.balanceOf(address(this))-beforeBalance==amount,"Inexact input");
        ethOut=_swap(route.pool,route.token,route.viaUSDG?address(usdg):address(weth),amount);
        if(route.viaUSDG) ethOut=_swap(fundingPool,address(usdg),address(weth),ethOut);
        require(ethOut>=minimumETH,"ETH slippage");
        weth.withdraw(ethOut);
        (bool ok,)=payable(msg.sender).call{value:ethOut}(""); require(ok,"ETH transfer failed");
        emit StockSold(ticker,msg.sender,amount,ethOut);
    }
    function buyRent(address recipient,uint256 minimumOut) external payable nonReentrant returns(uint256 amountOut) {
        require(buyer[msg.sender] && recipient==msg.sender,"Unauthorized buyer");
        require(msg.value>0 && minimumOut>0 && rentRouter!=address(0),"Invalid bounds");
        uint256 beforeBalance=rent.balanceOf(address(this));
        IRentBuyRouter(rentRouter).swapExactInputEthForRent{value:msg.value}(minimumOut,block.timestamp);
        amountOut=rent.balanceOf(address(this))-beforeBalance;
        require(amountOut>=minimumOut,"RENT slippage"); _deliver(rent,recipient,amountOut);
    }
    function _validate(address pool,address a,address b) private view {
        require(pool.code.length>0,"Missing pool");
        address t0=IPonsV3Pool(pool).token0(); address t1=IPonsV3Pool(pool).token1();
        require((t0==a && t1==b)||(t0==b && t1==a),"Wrong pair");
        require(factory.getPool(a,b,IPonsV3Pool(pool).fee())==pool,"Unregistered pool");
    }
    function _swap(address pool,address input,address output,uint256 amount) private returns(uint256 received) {
        require(pool!=address(0) && amount>0 && amount<=uint256(type(int256).max),"Invalid swap");
        bool zeroForOne=IPonsV3Pool(pool).token0()==input;
        uint256 beforeBalance=IERC20(output).balanceOf(address(this));
        callbackPool=pool; callbackToken=input; callbackAmount=amount;
        (int256 a,int256 b)=IPonsV3Pool(pool).swap(address(this),zeroForOne,int256(amount),
            zeroForOne?uint160(4295128740):uint160(1461446703485210103287273052203988822378723970341),"");
        require(callbackPool==address(0),"Missing callback");
        require((zeroForOne?a:b)==int256(amount),"Partial input");
        received=IERC20(output).balanceOf(address(this))-beforeBalance; require(received>0,"No output");
    }
    function uniswapV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external {
        require(msg.sender==callbackPool && callbackPool!=address(0),"Invalid callback");
        bool input0=IPonsV3Pool(msg.sender).token0()==callbackToken;
        int256 owed=input0?amount0:amount1;
        require(owed>0 && uint256(owed)==callbackAmount && (input0?amount1:amount0)<0,"Invalid payment");
        address token=callbackToken; callbackPool=address(0); callbackToken=address(0); callbackAmount=0;
        IERC20(token).safeTransfer(msg.sender,uint256(owed));
    }
    function _deliver(IERC20 token,address recipient,uint256 amount) private {
        uint256 beforeBalance=token.balanceOf(recipient); token.safeTransfer(recipient,amount);
        require(token.balanceOf(recipient)-beforeBalance==amount,"Inexact delivery");
    }
}
