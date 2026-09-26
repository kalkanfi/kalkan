// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @title Kalkan Live
/// @notice Same permissionless evacuation race as Shield, but the trigger is checked against a
///         real Chainlink price feed (USDC/USD on Monad testnet) instead of a keeper-pushed price.
///         Nobody pushes prices here: whoever evacuates reads the feed in the same call.
/// @dev Balances are virtual (testnet demo). Chainlink USD feeds use 8 decimals, like our 1e8 fixed point.
contract ShieldLive {
    uint256 public constant ONE = 1e8;
    uint128 public constant DEFAULT_AMOUNT = 10_000 * 1e8;
    uint128 public constant BOUNTY = 5 * 1e8;
    uint64 public constant MIN_TRIGGER = 90_000_000; // 0.90
    uint64 public constant MAX_TRIGGER = 99_999_000; // 0.99999
    uint256 public constant MAX_STALENESS = 2 days; // feed heartbeat is 24 h

    struct Position {
        address owner;
        uint64 trigger;
        bool open;
        uint128 amount;
        uint128 safe;
        uint64 evacPrice;
        uint64 evacBlock;
    }

    IAggregatorV3 public immutable feed;
    Position[] public positions;
    mapping(address => uint256) public rewards;

    event Protected(uint256 indexed id, address indexed owner, uint64 trigger, uint128 amount);
    event Evacuated(uint256 indexed id, address indexed owner, address indexed rescuer, uint64 price, uint128 safe);
    event Late(uint256 indexed id, address indexed rescuer);

    error BadTrigger();
    error BadFeed();
    error StalePrice();

    constructor(IAggregatorV3 feed_) {
        if (feed_.decimals() != 8) revert BadFeed();
        feed = feed_;
    }

    /// @notice Current Chainlink price (1e8). Reverts on a stale or invalid answer.
    function price() public view returns (uint64) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (block.timestamp - updatedAt > MAX_STALENESS) revert StalePrice();
        return uint64(uint256(answer));
    }

    function protect(uint64 trigger) external returns (uint256 id) {
        if (trigger < MIN_TRIGGER || trigger > MAX_TRIGGER) revert BadTrigger();
        id = positions.length;
        positions.push(Position(msg.sender, trigger, true, DEFAULT_AMOUNT, 0, 0, 0));
        emit Protected(id, msg.sender, trigger, DEFAULT_AMOUNT);
    }

    function evacuate(uint256 id) public returns (bool) {
        Position storage p = positions[id];
        uint64 px = price();
        if (!p.open || px >= p.trigger) {
            emit Late(id, msg.sender);
            return false;
        }
        uint128 safe = uint128(uint256(p.amount) * px / ONE);
        p.open = false;
        p.safe = safe;
        p.evacPrice = px;
        p.evacBlock = uint64(block.number);
        rewards[msg.sender] += BOUNTY;
        emit Evacuated(id, p.owner, msg.sender, px, safe);
        return true;
    }

    function evacuateMany(uint256[] calldata ids) external returns (uint256 done) {
        for (uint256 i; i < ids.length; ++i) {
            if (evacuate(ids[i])) done++;
        }
    }

    function positionCount() external view returns (uint256) {
        return positions.length;
    }
}
