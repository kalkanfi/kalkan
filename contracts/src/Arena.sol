// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Maker Arena
/// @notice An onchain propAMM league. Every player can quote a two-sided market around the
///         oracle price. A quote is anchored to the price at the maker's last refresh, so when
///         the oracle moves the quote goes stale and the race starts: the maker tries to
///         refresh, takers try to hit the stale quote first. Monad has no mempool, and blocks
///         arrive every 300 ms, so the block order decides the race.
/// @dev Balances are virtual (testnet demo). Prices and quantities use 1e8 fixed point.
contract Arena {
    uint256 public constant ONE = 1e8;
    uint256 public constant START_USD = 100_000 * ONE;
    uint256 public constant START_BASE = 1 * ONE;
    uint256 public constant QUOTE_TTL = 100; // blocks (~30 s at 300 ms)
    uint32 public constant MIN_SPREAD_BPS = 1;
    uint32 public constant MAX_SPREAD_BPS = 500;

    struct Player {
        int128 usd;
        int128 base;
        uint64 mid;
        uint32 spreadBps;
        uint64 size;
        uint64 refreshedAt;
        bool registered;
    }

    address public owner;
    address public keeper;
    uint64 public price;
    uint64 public priceBlock;
    uint256 public playerCount;

    mapping(address => Player) public players;

    event Registered(address indexed player);
    event Price(uint64 price);
    event Quote(address indexed maker, uint64 mid, uint32 spreadBps, uint64 size);
    event Fill(
        address indexed maker, address indexed taker, bool takerBuys, uint64 qty, uint64 execPrice, uint64 oraclePrice
    );
    event Miss(address indexed maker, address indexed taker, bool takerBuys, uint64 quotePrice, uint64 limitPrice);

    error NotKeeper();
    error NotOwner();
    error NotRegistered();
    error AlreadyRegistered();
    error NoPrice();
    error BadSpread();
    error BadSize();
    error QuoteExpired();
    error SelfTrade();
    error Insufficient();

    constructor(address keeper_) {
        owner = msg.sender;
        keeper = keeper_;
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert NotOwner();
        keeper = keeper_;
    }

    function pushPrice(uint64 px) external {
        if (msg.sender != keeper) revert NotKeeper();
        price = px;
        priceBlock = uint64(block.number);
        emit Price(px);
    }

    function register() external {
        Player storage p = players[msg.sender];
        if (p.registered) revert AlreadyRegistered();
        p.usd = int128(int256(START_USD));
        p.base = int128(int256(START_BASE));
        p.registered = true;
        playerCount++;
        emit Registered(msg.sender);
    }

    /// @notice Set spread and size, and anchor the quote to the current oracle price.
    function setQuote(uint32 spreadBps, uint64 size) external {
        Player storage p = _player(msg.sender);
        if (spreadBps < MIN_SPREAD_BPS || spreadBps > MAX_SPREAD_BPS) revert BadSpread();
        if (size == 0 || size > START_BASE) revert BadSize();
        p.spreadBps = spreadBps;
        p.size = size;
        _refresh(p);
    }

    /// @notice Re-anchor the quote to the current oracle price. This is the maker's defence.
    function refresh() external {
        _refresh(_player(msg.sender));
    }

    /// @notice Trade against a maker's quote. If the quote is worse than `limitPrice`
    ///         (the maker refreshed first), the race is lost: emit Miss instead of reverting,
    ///         so lost races are visible onchain too.
    function hit(address maker, bool takerBuys, uint64 qty, uint64 limitPrice) external returns (bool filled) {
        if (maker == msg.sender) revert SelfTrade();
        Player storage t = _player(msg.sender);
        Player storage m = players[maker];
        if (!m.registered || m.size == 0) revert NotRegistered();
        if (block.number > m.refreshedAt + QUOTE_TTL) revert QuoteExpired();
        if (qty == 0 || qty > m.size) revert BadSize();

        (uint64 bid, uint64 ask) = quoteOf(maker);
        uint64 px = takerBuys ? ask : bid;
        if (takerBuys ? px > limitPrice : px < limitPrice) {
            emit Miss(maker, msg.sender, takerBuys, px, limitPrice);
            return false;
        }

        int128 q = int128(uint128(qty));
        int128 cost = int128(uint128(uint256(qty) * px / ONE));
        if (takerBuys) {
            if (t.usd < cost || m.base < q) revert Insufficient();
            t.usd -= cost;
            t.base += q;
            m.usd += cost;
            m.base -= q;
        } else {
            if (t.base < q || m.usd < cost) revert Insufficient();
            t.base -= q;
            t.usd += cost;
            m.base += q;
            m.usd -= cost;
        }
        emit Fill(maker, msg.sender, takerBuys, qty, px, price);
        return true;
    }

    function quoteOf(address maker) public view returns (uint64 bid, uint64 ask) {
        Player storage m = players[maker];
        uint256 half = uint256(m.mid) * m.spreadBps / 10_000;
        bid = uint64(m.mid - half);
        ask = uint64(m.mid + half);
    }

    /// @notice Mark-to-market equity in USD (1e8).
    function equityOf(address who) external view returns (int256) {
        Player storage p = players[who];
        return int256(p.usd) + int256(p.base) * int256(uint256(price)) / int256(ONE);
    }

    function _player(address who) internal view returns (Player storage p) {
        p = players[who];
        if (!p.registered) revert NotRegistered();
    }

    function _refresh(Player storage p) internal {
        if (price == 0) revert NoPrice();
        if (p.size == 0) revert BadSize();
        p.mid = price;
        p.refreshedAt = uint64(block.number);
        emit Quote(msg.sender, price, p.spreadBps, p.size);
    }
}
