// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Shield} from "../src/Shield.sol";

contract ShieldTest is Test {
    Shield shield;
    address keeper = address(0xBEEF);
    address user = address(0xA11CE);
    address rescuer = address(0xB0B);
    address rescuer2 = address(0xC0C0);

    function setUp() public {
        shield = new Shield(keeper);
    }

    function _protect(uint64 trigger) internal returns (uint256 id) {
        vm.prank(user);
        id = shield.protect(trigger);
    }

    function _price(uint64 px) internal {
        vm.prank(keeper);
        shield.pushPrice(px);
    }

    function test_ProtectOpensPosition() public {
        uint256 id = _protect(99_000_000);
        (address o, uint64 t, bool open,, uint128 amount,,,) = shield.positions(id);
        assertEq(o, user);
        assertEq(t, 99_000_000);
        assertTrue(open);
        assertEq(amount, shield.DEFAULT_AMOUNT());
        assertEq(shield.openCount(), 1);
    }

    function test_NoEvacuationAbovePeg() public {
        uint256 id = _protect(99_000_000);
        vm.prank(rescuer);
        assertFalse(shield.evacuate(id));
        assertEq(shield.rewards(rescuer), 0);
    }

    function test_EvacuationBelowTriggerLocksValueAndPaysBounty() public {
        uint256 id = _protect(99_000_000);
        _price(98_500_000);
        vm.prank(rescuer);
        assertTrue(shield.evacuate(id));
        (,, bool open,,, uint128 safe, uint64 evacPrice,) = shield.positions(id);
        assertFalse(open);
        assertEq(evacPrice, 98_500_000);
        assertEq(safe, uint128(10_000 * 98_500_000));
        assertEq(shield.rewards(rescuer), shield.BOUNTY());
        assertEq(shield.evacuatedCount(), 1);
    }

    function test_SecondRescuerIsLateNotReverted() public {
        uint256 id = _protect(99_000_000);
        _price(98_000_000);
        vm.prank(rescuer);
        shield.evacuate(id);
        vm.prank(rescuer2);
        assertFalse(shield.evacuate(id));
        assertEq(shield.rewards(rescuer2), 0);
    }

    function test_SeedAndBatchEvacuate() public {
        vm.prank(keeper);
        shield.seed(100, 95_000_000, 99_500_000);
        assertEq(shield.positionCount(), 100);
        _price(97_000_000);
        uint256[] memory ids = new uint256[](100);
        for (uint256 i; i < 100; ++i) ids[i] = i;
        vm.prank(rescuer);
        uint256 done = shield.evacuateMany(ids);
        // triggers are spread 0.95..0.995: only those above 0.97 are due
        assertGt(done, 0);
        assertLt(done, 100);
        assertEq(shield.evacuatedCount(), done);
    }

    function test_BadTriggerReverts() public {
        vm.prank(user);
        vm.expectRevert(Shield.BadTrigger.selector);
        shield.protect(1e8);
    }

    function test_OnlyKeeperPushesPriceAndSeeds() public {
        vm.expectRevert(Shield.NotKeeper.selector);
        shield.pushPrice(1);
        vm.expectRevert(Shield.NotKeeper.selector);
        shield.seed(1, 95_000_000, 95_000_000);
    }
}
