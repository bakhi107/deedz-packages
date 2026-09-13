// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// @notice Indexed max heap over every Lit holder; supports increases, decreases and removal.
contract SeatIndexV6 {
    struct Node { address holder; uint256 count; }
    address public immutable deed;
    mapping(bytes32 => Node[]) private heaps;
    mapping(bytes32 => mapping(address => uint256)) private indexes;
    constructor() { deed = msg.sender; }
    function set(bytes32 ticker, address holder, uint256 count) external {
        require(msg.sender == deed, "Only deed");
        Node[] storage h = heaps[ticker];
        if (h.length == 0) h.push(Node(address(0), 0));
        uint256 i = indexes[ticker][holder];
        if (i == 0) {
            if (count == 0) return;
            h.push(Node(holder, count)); i = h.length - 1; indexes[ticker][holder] = i;
        } else if (count == 0) {
            uint256 last = h.length - 1;
            if (i != last) { h[i] = h[last]; indexes[ticker][h[i].holder] = i; }
            h.pop(); delete indexes[ticker][holder];
            if (i == h.length) return;
        } else h[i].count = count;
        while (i > 1 && higher(h[i], h[i / 2])) { swap(ticker, i, i / 2); i /= 2; }
        while (i * 2 < h.length) {
            uint256 child = i * 2;
            if (child + 1 < h.length && higher(h[child + 1], h[child])) ++child;
            if (!higher(h[child], h[i])) break;
            swap(ticker, i, child); i = child;
        }
    }
    function leader(bytes32 ticker) external view returns (address) {
        Node[] storage h = heaps[ticker]; if (h.length <= 1) return address(0);
        if ((h.length > 2 && h[2].count == h[1].count) || (h.length > 3 && h[3].count == h[1].count)) return address(0);
        return h[1].holder;
    }
    function countOf(bytes32 ticker, address holder) external view returns (uint256) {
        uint256 i = indexes[ticker][holder]; return i == 0 ? 0 : heaps[ticker][i].count;
    }
    function holderCount(bytes32 ticker) external view returns (uint256) { return heaps[ticker].length == 0 ? 0 : heaps[ticker].length - 1; }
    function higher(Node memory a, Node memory b) private pure returns (bool) { return a.count > b.count || (a.count == b.count && a.holder < b.holder); }
    function swap(bytes32 ticker, uint256 a, uint256 b) private {
        Node[] storage h = heaps[ticker]; Node memory tmp = h[a]; h[a] = h[b]; h[b] = tmp;
        indexes[ticker][h[a].holder] = a; indexes[ticker][h[b].holder] = b;
    }
}
