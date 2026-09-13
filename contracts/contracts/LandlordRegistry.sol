// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ITickerRegistry} from "./interfaces/ITickerRegistry.sol";

/// @title LandlordRegistry
/// @notice Maintains exact per-ticker plurality with an indexed max heap.
contract LandlordRegistry is Ownable {
    uint256 public constant LANDLORD_THRESHOLD_BPS = 2_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    error InvalidAddress();
    error OwnershipUnderflow(bytes32 ticker, address holder);

    struct HolderNode {
        address holder;
        uint32 deedCount;
    }

    ITickerRegistry public immutable registry;

    mapping(bytes32 ticker => HolderNode[] heap) private _heaps;
    mapping(bytes32 ticker => mapping(address holder => uint256 index)) private _indices;

    event OwnershipUpdated(bytes32 indexed ticker, address indexed holder, uint256 deedCount);
    event LandlordChanged(bytes32 indexed ticker, address indexed landlord, uint256 deedCount, uint256 shareBps);

    constructor(address market, address registry_) Ownable(market) {
        if (market == address(0) || registry_ == address(0)) revert InvalidAddress();
        registry = ITickerRegistry(registry_);
    }

    function updateOwnership(bytes32 ticker, address from, address to) external onlyOwner {
        if (from == to) return;
        (address oldLandlord,,) = landlordOf(ticker);

        if (from != address(0)) _decrement(ticker, from);
        if (to != address(0)) _increment(ticker, to);

        (address newLandlord, uint256 deedCount, uint256 shareBps) = landlordOf(ticker);
        if (newLandlord != oldLandlord) emit LandlordChanged(ticker, newLandlord, deedCount, shareBps);
    }

    function landlordOf(bytes32 ticker) public view returns (address landlord, uint256 deedCount, uint256 shareBps) {
        HolderNode[] storage heap = _heaps[ticker];
        if (heap.length <= 1) return (address(0), 0, 0);

        HolderNode storage leader = heap[1];
        uint256 secondCount;
        if (heap.length > 2) secondCount = heap[2].deedCount;
        if (heap.length > 3 && heap[3].deedCount > secondCount) secondCount = heap[3].deedCount;

        ITickerRegistry.TickerConfig memory config = registry.getTicker(ticker);
        uint256 threshold = (uint256(config.deedSupply) * LANDLORD_THRESHOLD_BPS + BPS_DENOMINATOR - 1)
            / BPS_DENOMINATOR;
        if (leader.deedCount < threshold || leader.deedCount == secondCount) return (address(0), 0, 0);

        landlord = leader.holder;
        deedCount = leader.deedCount;
        shareBps = uint256(leader.deedCount) * BPS_DENOMINATOR / config.deedSupply;
    }

    function deedCountOf(bytes32 ticker, address holder) external view returns (uint256) {
        uint256 index = _indices[ticker][holder];
        return index == 0 ? 0 : _heaps[ticker][index].deedCount;
    }

    function holderCount(bytes32 ticker) external view returns (uint256) {
        uint256 length = _heaps[ticker].length;
        return length == 0 ? 0 : length - 1;
    }

    function _increment(bytes32 ticker, address holder) private {
        _initialize(ticker);
        uint256 index = _indices[ticker][holder];
        if (index == 0) {
            _heaps[ticker].push(HolderNode({holder: holder, deedCount: 1}));
            index = _heaps[ticker].length - 1;
            _indices[ticker][holder] = index;
        } else {
            ++_heaps[ticker][index].deedCount;
        }
        _bubbleUp(ticker, index);
        emit OwnershipUpdated(ticker, holder, _heaps[ticker][_indices[ticker][holder]].deedCount);
    }

    function _decrement(bytes32 ticker, address holder) private {
        uint256 index = _indices[ticker][holder];
        if (index == 0) revert OwnershipUnderflow(ticker, holder);
        HolderNode[] storage heap = _heaps[ticker];
        uint256 newCount = uint256(heap[index].deedCount) - 1;
        if (newCount == 0) {
            uint256 last = heap.length - 1;
            if (index != last) {
                heap[index] = heap[last];
                _indices[ticker][heap[index].holder] = index;
            }
            heap.pop();
            delete _indices[ticker][holder];
            if (index < heap.length) {
                index = _bubbleUp(ticker, index);
                _bubbleDown(ticker, index);
            }
        } else {
            heap[index].deedCount = uint32(newCount);
            _bubbleDown(ticker, index);
        }
        emit OwnershipUpdated(ticker, holder, newCount);
    }

    function _initialize(bytes32 ticker) private {
        if (_heaps[ticker].length == 0) _heaps[ticker].push(HolderNode({holder: address(0), deedCount: 0}));
    }

    function _bubbleUp(bytes32 ticker, uint256 index) private returns (uint256) {
        while (index > 1) {
            uint256 parent = index / 2;
            if (!_higherPriority(_heaps[ticker][index], _heaps[ticker][parent])) break;
            _swap(ticker, index, parent);
            index = parent;
        }
        return index;
    }

    function _bubbleDown(bytes32 ticker, uint256 index) private {
        HolderNode[] storage heap = _heaps[ticker];
        while (true) {
            uint256 left = index * 2;
            if (left >= heap.length) return;
            uint256 best = left;
            uint256 right = left + 1;
            if (right < heap.length && _higherPriority(heap[right], heap[left])) best = right;
            if (!_higherPriority(heap[best], heap[index])) return;
            _swap(ticker, index, best);
            index = best;
        }
    }

    function _swap(bytes32 ticker, uint256 a, uint256 b) private {
        HolderNode memory node = _heaps[ticker][a];
        _heaps[ticker][a] = _heaps[ticker][b];
        _heaps[ticker][b] = node;
        _indices[ticker][_heaps[ticker][a].holder] = a;
        _indices[ticker][_heaps[ticker][b].holder] = b;
    }

    function _higherPriority(HolderNode storage a, HolderNode storage b) private view returns (bool) {
        return a.deedCount > b.deedCount || (a.deedCount == b.deedCount && uint160(a.holder) < uint160(b.holder));
    }
}
