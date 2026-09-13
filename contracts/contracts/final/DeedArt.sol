// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice On-chain renderer matching apps/web/scripts/generate-deed-svg.mjs.
contract DeedArt {
    using Strings for uint256;

    struct Card {
        bytes32 ticker;
        uint256 serial;
        uint8 state;
        uint256 price;
        uint256 runway;
        bool fused;
        bool throne;
        uint256 lifetime;
    }

    function render(Card memory c) external pure returns (string memory) {
        string memory ticker = text(c.ticker);
        bool active = c.state == 1;
        bool grace = c.state == 2;
        string memory color = active ? "#CCFF00" : "#FF1833";
        string memory hotColor = active ? "#F5FFD0" : "#FFE0E5";
        string memory title = active ? "LIT DEED" : grace ? "GOING DARK" : "DARK DEED";
        string memory status = active ? "[STATUS: ONLINE &amp; EARNING]" : grace ? "[STATUS: GRACE PERIOD // TOP UP REQUIRED]" : "[STATUS: DORMANT // SECURED IN WALLET]";
        string memory expiry = active
            ? string.concat("[RENT TIME LEFT: ", formatRunway(c.runway), "]")
            : "[RENT TIME LEFT: LOCKED - BURN TO START]";
        string memory serial = pad3(c.serial);

        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" role="img" aria-labelledby="title desc">',
            '<title id="title">', ticker, " ", title, '</title><desc id="desc">DEEDZ ', title,
            ", clan allocation ", serial, " of 250.</desc><defs>",
            '<filter id="bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="13"/></filter>',
            '<filter id="halo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4.5"/></filter>',
            '<pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0v48" fill="none" stroke="', color, '" stroke-width=".8" opacity=".13"/></pattern>',
            '<pattern id="signalDust" width="31" height="29" patternUnits="userSpaceOnUse"><circle cx="4" cy="6" r="1.2" fill="', hotColor,
            '" opacity=".72"/><circle cx="18" cy="12" r=".8" fill="', color, '" opacity=".7"/><circle cx="27" cy="23" r="1.5" fill="', color,
            '" opacity=".46"/><circle cx="10" cy="25" r=".7" fill="', hotColor, '" opacity=".55"/></pattern>',
            '<clipPath id="signalShard"><path d="M510 601V681.5L560.8 645.4Z"/></clipPath><style>.mono{font-family:\'Courier New\',monospace;letter-spacing:5px}.line{fill:none;stroke:',
            color, '}.state{fill:', color, "}</style></defs>",
            '<rect width="1200" height="1500" fill="#000"/><rect x="24" y="24" width="1152" height="1452" rx="2" fill="#020202"/>'
        );

        svg = string.concat(svg,
            '<g transform="scale(1.5)"><rect x="25" y="25" width="750" height="950" class="line" stroke-width="2"/><rect x="34" y="34" width="732" height="932" class="line" stroke-width="1" opacity=".72"/>',
            '<g class="line" stroke-linejoin="miter"><path d="M50 116V50h66M58 98V58h40M66 82V66h16M50 50h66l-66 66M58 58h40L58 98M66 66h16L66 82" stroke-width="2"/>',
            '<path d="M750 116V50h-66M742 98V58h-40M734 82V66h-16M750 50h-66l66 66M742 58h-40l40 40M734 66h-16l16 16" stroke-width="2"/>',
            '<path d="M50 884v66h66M58 902v40h40M66 918v16h16M50 950h66l-66-66M58 942h40l-40-40M66 934h16l-16-16" stroke-width="2"/>',
            '<path d="M750 884v66h-66M742 902v40h-40M734 918v16h-16M750 950h-66l66-66M742 942h-40l40-40M734 934h-16l16-16" stroke-width="2"/></g>',
            '<path d="M126 54h84M230 54h142M428 54h142M590 54h84M126 946h84M230 946h142M428 946h142M590 946h84" class="line" stroke-width="1.4"/>',
            '<path d="M220 46l8 8-8 8-8-8ZM400 44l10 10-10 10-10-10ZM580 46l8 8-8 8-8-8ZM220 938l8 8-8 8-8-8ZM400 936l10 10-10 10-10-10ZM580 938l8 8-8 8-8-8Z" class="state"/>',
            '<path d="M54 132v72M54 246v74M54 366v222M54 634v74M54 750v118M746 132v72M746 246v74M746 366v222M746 634v74M746 750v118" class="line" stroke-width="1.5"/>',
            '<path d="M54 214l7 7-7 7-7-7ZM54 342l9 9-9 9-9-9ZM54 610l9 9-9 9-9-9ZM54 722l7 7-7 7-7-7ZM746 214l7 7-7 7-7-7ZM746 342l9 9-9 9-9-9ZM746 610l9 9-9 9-9-9ZM746 722l7 7-7 7-7-7Z" class="state"/>',
            '<path d="M45 280h18M54 271v18M45 794h18M54 785v18M737 280h18M746 271v18M737 794h18M746 785v18" class="line" stroke-width="2"/>',
            '<path d="M54 378v38M54 430v8M54 450v5M54 468v3M54 480v2M54 542v38M746 378v38M746 430v8M746 450v5M746 468v3M746 480v2M746 542v38" class="line" stroke-width="2" stroke-linecap="round"/></g>'
        );

        svg = string.concat(svg,
            '<text x="600" y="164" text-anchor="middle" class="mono state" font-size="22">DEEDZ PROTOCOL TERMINAL</text><path d="M210 196H990" class="line" opacity=".65"/><circle cx="600" cy="196" r="7" class="state"/>',
            '<text x="600" y="276" text-anchor="middle" class="mono state" font-size="72" font-weight="900">', title,
            '</text><path d="M330 302H870" class="line" opacity=".65"/><text x="600" y="344" text-anchor="middle" class="mono state" font-size="19">CERTIFICATE</text>',
            '<rect x="178" y="386" width="844" height="520" class="line" stroke-width="2"/><rect x="204" y="412" width="792" height="468" fill="url(#grid)"/>',
            '<path d="M204 438v-26h26M970 412h26v26M204 854v26h26M970 880h26v-26" class="line" stroke-width="3"/><path d="M204 646H996M600 412V880" class="line" stroke-width="1.2" stroke-dasharray="3 7" opacity=".58"/>',
            '<path d="M204 646l10-10 10 10-10 10ZM986 646l10-10 10 10-10 10ZM600 402l10 10-10 10-10-10ZM600 870l10 10-10 10-10-10Z" class="state"/>',
            '<g class="line" opacity=".26" stroke-width="1"><ellipse cx="600" cy="595" rx="238" ry="126"/><ellipse cx="600" cy="595" rx="238" ry="126" transform="rotate(30 600 595)"/><ellipse cx="600" cy="595" rx="238" ry="126" transform="rotate(60 600 595)"/><ellipse cx="600" cy="595" rx="238" ry="126" transform="rotate(90 600 595)"/><ellipse cx="600" cy="595" rx="238" ry="126" transform="rotate(120 600 595)"/><ellipse cx="600" cy="595" rx="238" ry="126" transform="rotate(150 600 595)"/></g>'
        );

        svg = string.concat(svg,
            '<path d="M315 820V430L760 820H315L850 440" fill="none" stroke="', color, '" stroke-width="22" stroke-linejoin="miter" opacity=".24" filter="url(#bloom)"/>',
            '<path d="M315 820V430L760 820H315L850 440" fill="none" stroke="', color, '" stroke-width="10" stroke-linejoin="miter" opacity=".72" filter="url(#halo)"/>',
            '<path d="M315 820V430L760 820H315L850 440" fill="none" stroke="', color, '" stroke-width="5" stroke-linejoin="miter"/><path d="M315 820V430L760 820H315L850 440" fill="none" stroke="', hotColor, '" stroke-width="1.7" stroke-linejoin="miter" opacity=".96"/>',
            '<path d="M510 601V681.5L560.8 645.4Z" fill="', color, '" fill-opacity=".56" stroke="', color, '" stroke-width="2"/><path d="M510 601V681.5L560.8 645.4Z" fill="', color, '" opacity=".42" filter="url(#bloom)"/>',
            '<rect x="500" y="590" width="72" height="104" fill="url(#signalDust)" clip-path="url(#signalShard)"/><path d="M510 601V681.5L560.8 645.4Z" fill="none" stroke="', hotColor, '" stroke-width="1.3" opacity=".88"/>',
            '<text x="600" y="785" text-anchor="middle" class="mono state" font-size="54" font-weight="900">', ticker, "</text>"
        );

        svg = string.concat(svg,
            '<rect x="178" y="936" width="844" height="310" class="line" stroke-width="3"/><path d="M600 936v86M178 1022h844M178 1126h844" class="line" opacity=".72"/>',
            '<text x="208" y="974" class="mono state" font-size="16">TICKER</text><text x="208" y="1010" class="mono state" font-size="34" font-weight="700">', ticker, '</text>',
            '<text x="630" y="974" class="mono state" font-size="16">CLAN ALLOCATION</text><text x="630" y="1010" class="mono state" font-size="34" font-weight="700">', serial, ' / 250</text>',
            '<text x="208" y="1062" class="mono state" font-size="16">STATUS</text><text x="208" y="1106" class="mono state" font-size="21">', status, '</text>',
            '<text x="208" y="1166" class="mono state" font-size="16">RENT TIME LEFT</text><text x="208" y="1210" class="mono state" font-size="21">', expiry, '</text>',
            '<path d="M600 1246v42M180 1334H500M700 1334h320" class="line" stroke-width="2"/><circle cx="600" cy="1334" r="58" class="line" stroke-width="2"/><circle cx="600" cy="1334" r="48" class="line" stroke-width="1" stroke-dasharray="3 5"/>',
            '<g class="line" stroke-width="2.1" stroke-linecap="round"><path d="M568 1359v-29c0-44 64-48 64-1v31"/><path d="M577 1366v-36c0-32 46-35 46-1v37"/><path d="M586 1370v-41c0-20 28-21 28 0v42"/><path d="M595 1372v-43c0-8 10-8 10 0v44"/><path d="M562 1348c-8-19-3-42 13-55 21-17 53-12 67 10 11 17 11 40 2 58"/><path d="M557 1334c-2-27 14-51 39-58 27-7 56 8 66 34"/></g></svg>'
        );

        string memory attributes = string.concat(
            '{"trait_type":"ticker","value":"', ticker,
            '"},{"trait_type":"status","value":"', active ? "Lit" : grace ? "Going Dark" : "Dark",
            '"},{"trait_type":"price","value":', decimal(c.price),
            '},{"trait_type":"runwayDays","value":', decimal(c.runway),
            '},{"trait_type":"fused","value":', c.fused ? "true" : "false",
            '},{"trait_type":"throne","value":', c.throne ? "true" : "false",
            '},{"trait_type":"lifetimeRentUSD","value":', decimal(c.lifetime), "}"
        );
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(string.concat(
                '{"name":"DEEDZ ', ticker, " #", serial,
                '","description":"Mint free. Light it up. Pay rent. Earn stock.","image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(svg)), '\",\"attributes\":[', attributes, "]}"
            )))
        );
    }

    function formatRunway(uint256 days6) private pure returns (string memory) {
        uint256 minutesTotal = days6 * 1440 / 1e6;
        uint256 daysWhole = minutesTotal / 1440;
        uint256 hoursPart = minutesTotal % 1440 / 60;
        uint256 minutesPart = minutesTotal % 60;
        return string.concat(pad2(daysWhole), "d : ", pad2(hoursPart), "h : ", pad2(minutesPart), "m");
    }

    function pad2(uint256 value) private pure returns (string memory) {
        return value < 10 ? string.concat("0", value.toString()) : value.toString();
    }

    function pad3(uint256 value) private pure returns (string memory) {
        if (value < 10) return string.concat("00", value.toString());
        if (value < 100) return string.concat("0", value.toString());
        return value.toString();
    }

    function decimal(uint256 value) private pure returns (string memory) {
        string memory digits = (1e6 + value % 1e6).toString();
        bytes memory tail = new bytes(6);
        for (uint256 i; i < 6; ++i) tail[i] = bytes(digits)[i + 1];
        return string.concat((value / 1e6).toString(), ".", string(tail));
    }

    function text(bytes32 value) private pure returns (string memory) {
        uint256 length;
        while (length < 32 && value[length] != 0) ++length;
        bytes memory result = new bytes(length);
        for (uint256 i; i < length; ++i) result[i] = value[i];
        return string(result);
    }
}
