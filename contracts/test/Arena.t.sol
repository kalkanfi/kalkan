// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Arena} from "../src/Arena.sol";

contract ArenaTest is Test {
    Arena arena;
    address keeper = address(0xBEEF);
    address maker = address(0xA11CE);
    address taker = address(0xB0B);

    uint64 constant PX = 65_000e8;

    function setUp() public {
        arena = new Arena(keeper);
        vm.prank(keeper);
        arena.pushPrice(PX);
        vm.prank(maker);
        arena.register();
        vm.prank(taker);
        arena.register();
        vm.prank(maker);
        arena.setQuote(10, 0.5e8); // 10 bps, 0.5 BTC
    }

    function test_RegisterGivesStartingBalances() public view {
        (int128 usd, int128 base,,,,, bool reg) = arena.players(taker);
        assertEq(usd, int128(int256(arena.START_USD())));
        assertEq(base, int128(int256(arena.START_BASE())));
        assertTrue(reg);
        assertEq(arena.playerCount(), 2);
    }

    function test_QuoteAnchorsToOracle() public view {
        (uint64 bid, uint64 ask) = arena.quoteOf(maker);
        assertEq(bid, PX - PX * 10 / 10_000);
        assertEq(ask, PX + PX * 10 / 10_000);
    }

    function test_HitAtAskMovesBalances() public {
        (, uint64 ask) = arena.quoteOf(maker);
        vm.prank(taker);
        bool filled = arena.hit(maker, true, 0.1e8, ask);
        assertTrue(filled);
        (int128 tUsd, int128 tBase,,,,,) = arena.players(taker);
        assertEq(tBase, int128(1.1e8));
        assertEq(tUsd, int128(int256(arena.START_USD())) - int128(uint128(uint256(0.1e8) * ask / 1e8)));
    }

    function test_StaleQuoteIsProfitableForTaker() public {
        // Oracle jumps +1%, maker has not refreshed: buying at the old ask is profitable.
        vm.prank(keeper);
        arena.pushPrice(PX * 101 / 100);
        (, uint64 ask) = arena.quoteOf(maker);
        int256 before = arena.equityOf(taker);
        vm.prank(taker);
        arena.hit(maker, true, 0.5e8, ask);
        assertGt(arena.equityOf(taker), before);
    }

    function test_MakerRefreshFirstMeansTakerMisses() public {
        (, uint64 staleAsk) = arena.quoteOf(maker);
        vm.prank(keeper);
        arena.pushPrice(PX * 101 / 100);
        vm.prank(maker);
        arena.refresh(); // maker wins the race
        vm.prank(taker);
        bool filled = arena.hit(maker, true, 0.1e8, staleAsk);
        assertFalse(filled);
        (, int128 tBase,,,,,) = arena.players(taker);
        assertEq(tBase, int128(1e8));
    }

    function test_QuoteExpires() public {
        vm.roll(block.number + arena.QUOTE_TTL() + 1);
        (, uint64 ask) = arena.quoteOf(maker);
        vm.prank(taker);
        vm.expectRevert(Arena.QuoteExpired.selector);
        arena.hit(maker, true, 0.1e8, ask);
    }

    function test_OnlyKeeperPushesPrice() public {
        vm.expectRevert(Arena.NotKeeper.selector);
        arena.pushPrice(1);
    }
}
