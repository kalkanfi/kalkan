// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShieldLive, IAggregatorV3} from "../src/ShieldLive.sol";

contract MockFeed is IAggregatorV3 {
    int256 public answer = 99_986_850;
    uint256 public updatedAt;

    constructor() {
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

contract ShieldLiveTest is Test {
    MockFeed feed;
    ShieldLive shield;
    address user = address(0xA11CE);
    address rescuer = address(0xB0B);

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockFeed();
        feed.set(99_986_850, block.timestamp);
        shield = new ShieldLive(feed);
    }

    function test_TriggerAboveFeedIsEvacuableAtFeedPrice() public {
        vm.prank(user);
        uint256 id = shield.protect(99_990_000); // 0.9999 > 0.99986850
        vm.prank(rescuer);
        assertTrue(shield.evacuate(id));
        (,,,, uint128 safe, uint64 evacPrice,) = shield.positions(id);
        assertEq(evacPrice, 99_986_850);
        assertEq(safe, uint128(10_000 * 99_986_850));
        assertEq(shield.rewards(rescuer), shield.BOUNTY());
    }

    function test_TriggerBelowFeedIsNotEvacuable() public {
        vm.prank(user);
        uint256 id = shield.protect(99_000_000);
        vm.prank(rescuer);
        assertFalse(shield.evacuate(id));
    }

    function test_StaleFeedReverts() public {
        vm.prank(user);
        uint256 id = shield.protect(99_990_000);
        vm.warp(block.timestamp + 3 days);
        vm.prank(rescuer);
        vm.expectRevert(ShieldLive.StalePrice.selector);
        shield.evacuate(id);
    }
}
