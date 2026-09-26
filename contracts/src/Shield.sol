// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Kalkan (Depeg Shield)
/// @notice Protect a stablecoin position with a price trigger. The moment the oracle price
///         falls below the trigger, ANYONE can evacuate the position into the safe asset at the
///         current price and earn a bounty. Rescuers race for bounties, so positions get out
///         within blocks, with no bot or server the user has to trust.
///         Monad: 300 ms blocks, no public mempool to front-run an exit.
/// @dev Balances are virtual (testnet demo). Prices use 1e8 fixed point (1.00 USD = 1e8).
contract Shield {
    uint256 public constant ONE = 1e8;
    uint128 public constant DEFAULT_AMOUNT = 10_000 * 1e8; // 10,000 USDX per position
    uint128 public constant BOUNTY = 5 * 1e8; // $5 per evacuation, paid from protection fees
    uint64 public constant MIN_TRIGGER = 90_000_000; // 0.90
    uint64 public constant MAX_TRIGGER = 99_990_000; // 0.9999

    struct Position {
        address owner;
        uint64 trigger;
        bool open;
        bool demo;
        uint128 amount; // USDX
        uint128 safe; // USD value received at evacuation
        uint64 evacPrice;
        uint64 evacBlock;
    }

    address public owner;
    address public keeper;
    uint64 public price = uint64(ONE);
    uint64 public priceBlock;

    Position[] public positions;
    mapping(address => uint256) public rewards; // rescuer bounties (virtual USD)
    uint256 public openCount;
    uint256 public evacuatedCount;

    event Price(uint64 price);
    event Protected(uint256 indexed id, address indexed owner, uint64 trigger, uint128 amount, bool demo);
    event Evacuated(uint256 indexed id, address indexed owner, address indexed rescuer, uint64 price, uint128 safe);
    event Late(uint256 indexed id, address indexed rescuer);

    error NotKeeper();
    error NotOwner();
    error BadTrigger();

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

    /// @notice Open a protected position: "get me out if USDX drops below `trigger`".
    function protect(uint64 trigger) external returns (uint256 id) {
        return _open(msg.sender, trigger, false);
    }

    /// @notice Keeper-only: open labelled demo positions for the stress test (how many exits fit in a block?).
    function seed(uint256 count, uint64 lowTrigger, uint64 highTrigger) external {
        if (msg.sender != keeper) revert NotKeeper();
        uint64 step = count > 1 ? (highTrigger - lowTrigger) / uint64(count - 1) : 0;
        for (uint256 i; i < count; ++i) {
            _open(msg.sender, lowTrigger + step * uint64(i), true);
        }
    }

    /// @notice Evacuate one position. Anyone can call once the price is below the trigger.
    ///         If someone else got there first, the late attempt is recorded (Late), not reverted.
    function evacuate(uint256 id) public returns (bool) {
        Position storage p = positions[id];
        if (!p.open || price >= p.trigger) {
            emit Late(id, msg.sender);
            return false;
        }
        uint128 safe = uint128(uint256(p.amount) * price / ONE);
        p.open = false;
        p.safe = safe;
        p.evacPrice = price;
        p.evacBlock = uint64(block.number);
        openCount--;
        evacuatedCount++;
        rewards[msg.sender] += BOUNTY;
        emit Evacuated(id, p.owner, msg.sender, price, safe);
        return true;
    }

    /// @notice Evacuate many positions in one transaction (rescuer bots, stress test).
    function evacuateMany(uint256[] calldata ids) external returns (uint256 done) {
        for (uint256 i; i < ids.length; ++i) {
            if (evacuate(ids[i])) done++;
        }
    }

    function positionCount() external view returns (uint256) {
        return positions.length;
    }

    function _open(address who, uint64 trigger, bool demo) internal returns (uint256 id) {
        if (trigger < MIN_TRIGGER || trigger > MAX_TRIGGER) revert BadTrigger();
        id = positions.length;
        positions.push(Position(who, trigger, true, demo, DEFAULT_AMOUNT, 0, 0, 0));
        openCount++;
        emit Protected(id, who, trigger, DEFAULT_AMOUNT, demo);
    }
}
