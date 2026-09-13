// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import "@openzeppelin/contracts/access/AccessControl.sol";

interface TokenInterface {
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function mint(address account, uint256 amount) external;
    function burn(uint256 value) external;
    function burnFrom(address account, uint256 value) external;
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title ChallengeLending
/// @notice Virtual ETH-collateral / USD-debt lending challenge contract.
///         All token amounts use 2 decimal places (100 units = 1.00 token).
///         vETHPrice is expressed as vUSD units per 1 full vETH (100 units),
///         e.g. 200000 = 2000.00 vUSD/vETH.
///         Health factor is stored scaled ×100: 100 = HF of 1.00 (liquidation boundary).
contract ChallengeLending is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint256 public constant MAX_LTV = 75;          // 75% — maximum loan-to-value ratio
    uint256 public constant LIQUI_THRESHOLD = 78;  // 78% — liquidation threshold
    uint256 public constant LIQUI_PENALTY = 5;     // 5%  — bonus collateral seized on liquidation

    TokenInterface public vETH;
    TokenInterface public vUSD;
    uint256 public vETHPrice = 200000;      // 2000.00 vUSD per vETH
    uint256 public start_vETH = 1000;       // 10.00 vETH minted to user on join
    uint256 public start_Collateral = 500;  // 5.00 vETH locked as collateral on join
    uint256 public start_Debt = 700000;     // 7000.00 vUSD initial debt on join (also minted to user's wallet)

    struct userPosition {
        uint256 collateral;       // vETH units
        uint256 debt;             // vUSD units
        uint256 hf;               // health factor ×100
        uint256 numOperations;    // count of deposit/borrow/repay/withdrawCollateral calls
        uint256 lastUpdateTime;   // timestamp of last debt change
        uint256 cumulativeDebtTime; // sum of (debt × elapsed seconds)
    }

    address[] public users;
    uint256 public numUsers;
    mapping(address => bool)         public isUser;
    mapping(address => userPosition) public positions;

    // Registration gate — join() reverts unless this is true
    bool public challengeOpen;

    // Scenario timing — all debt-time is measured from this shared start point
    uint256 public scenarioStartTime; // 0 = not started; set by admin via start()
    uint256 public scenarioEndTime;   // 0 = not stopped; set by admin via stop()

    // Final loan-continuity scores computed at stop() — basis points (10000 = 100%)
    mapping(address => uint256) public loanContinuityScore;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ChallengeOpened();
    event ChallengeClosed();
    event PriceUpdate(uint256 oldPrice, uint256 newPrice);
    event ChallengeStarted(uint256 startTime);
    event ChallengeStopped(uint256 endTime, uint256 duration);
    event LoanContinuityScored(address indexed user, uint256 score);
    event Join(address indexed user);
    event Deposit(address indexed user, uint256 amount);
    event Borrow(address indexed user, uint256 amount);
    event Repay(address indexed user, uint256 amount);
    event WithdrawCollateral(address indexed user, uint256 amount);
    event Liquidated(address indexed user, uint256 debtRepaid, uint256 collateralSeized);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _vETHaddress, address _vUSDaddress) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        vETH = TokenInterface(_vETHaddress);
        vUSD = TokenInterface(_vUSDaddress);
        challengeOpen = false;
        scenarioStartTime = 0;
        scenarioEndTime = 0;
    }

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    /// @dev Requires the challenge to be open AND the scenario to have started.
    modifier onlyActive() {
        require(challengeOpen, "Challenge is not open");
        require(scenarioStartTime > 0, "Scenario has not started");
        _;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Accumulate (debt × elapsed time) before any debt change.
    ///      Time only counts between scenarioStartTime and scenarioEndTime (or now if
    ///      not yet stopped), so all participants share the same scoring window.
    function _updateDebtTime(address user) internal {
        if (positions[user].lastUpdateTime != 0 && scenarioStartTime > 0) {
            uint256 from = positions[user].lastUpdateTime < scenarioStartTime
                ? scenarioStartTime
                : positions[user].lastUpdateTime;
            uint256 to = (scenarioEndTime > 0 && block.timestamp > scenarioEndTime)
                ? scenarioEndTime
                : block.timestamp;
            if (to > from) {
                positions[user].cumulativeDebtTime += positions[user].debt * (to - from);
            }
        }
        positions[user].lastUpdateTime = block.timestamp;
    }

    // -------------------------------------------------------------------------
    // User actions
    // -------------------------------------------------------------------------

    /// @notice Join the challenge — creates a virtual position for the caller.
    function join() external {
        require(challengeOpen, "Challenge is not open");
        require(!isUser[msg.sender], "Already joined");
        users.push(msg.sender);
        isUser[msg.sender] = true;
        numUsers++;

        // Mint free tokens to the user
        vETH.mint(msg.sender, start_vETH - start_Collateral);
        vUSD.mint(msg.sender, start_Debt);

        // Lock collateral and record debt in the contract
        vETH.mint(address(this), start_Collateral);
        positions[msg.sender].collateral = start_Collateral;
        positions[msg.sender].debt = start_Debt;

        positions[msg.sender].lastUpdateTime = block.timestamp;
        calcHF(msg.sender);
        emit Join(msg.sender);
    }

    /// @notice Deposit additional vETH as collateral.
    function deposit(uint256 amount) external onlyActive {
        require(isUser[msg.sender], "Not a participant");
        require(vETH.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        positions[msg.sender].collateral += amount;
        positions[msg.sender].numOperations++;
        calcHF(msg.sender);
        emit Deposit(msg.sender, amount);
    }

    /// @notice Borrow vUSD against collateral.
    function borrow(uint256 amount) external onlyActive {
        require(isUser[msg.sender], "Not a participant");
        // Check total debt (existing + new) stays within MAX_LTV
        require(
            positions[msg.sender].collateral >= minCollateral(positions[msg.sender].debt + amount),
            "Insufficient collateral"
        );
        vUSD.mint(msg.sender, amount);
        _updateDebtTime(msg.sender);
        positions[msg.sender].debt += amount;
        positions[msg.sender].numOperations++;
        calcHF(msg.sender);
        emit Borrow(msg.sender, amount);
    }

    /// @notice Repay vUSD debt.
    function repay(uint256 amount) external onlyActive {
        require(isUser[msg.sender], "Not a participant");
        require(positions[msg.sender].debt >= amount, "Too much repayment");
        vUSD.burnFrom(msg.sender, amount);
        _updateDebtTime(msg.sender);
        positions[msg.sender].debt -= amount;
        positions[msg.sender].numOperations++;
        calcHF(msg.sender);
        emit Repay(msg.sender, amount);
    }

    /// @notice Withdraw collateral — only allowed when debt is fully repaid.
    function withdrawCollateral(uint256 amount) external onlyActive {
        require(isUser[msg.sender], "Not a participant");
        require(positions[msg.sender].collateral >= amount, "Not enough collateral");
        require(
            positions[msg.sender].collateral - amount >= minCollateral(positions[msg.sender].debt),
            "Collateral below minimum"
        );
        require(vETH.transfer(msg.sender, amount), "Transfer failed");
        positions[msg.sender].collateral -= amount;
        positions[msg.sender].numOperations++;
        calcHF(msg.sender);
        emit WithdrawCollateral(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Math helpers
    // -------------------------------------------------------------------------

    /// @notice Minimum vETH collateral units required to support `totalDebt` vUSD at MAX_LTV.
    /// @dev    collateral × vETHPrice / 100 × MAX_LTV / 100 ≥ totalDebt
    ///         ⟹ collateral ≥ totalDebt × 10000 / (vETHPrice × MAX_LTV)
    ///         Uses ceiling division so the result always satisfies the constraint.
    function minCollateral(uint256 totalDebt) public view returns (uint256) {
        uint256 denom = vETHPrice * MAX_LTV;
        return (totalDebt * 10000 + denom - 1) / denom;
    }

    // -------------------------------------------------------------------------
    // Health factor and liquidation
    // -------------------------------------------------------------------------

    /// @notice Compute and store the health factor for `user` (scaled ×100).
    ///         HF = (collateral_units × vETHPrice × LIQUI_THRESHOLD) / (100 × debt_units)
    ///         100 = exactly at liquidation threshold (HF 1.00).
    function calcHF(address user) public returns (uint256) {
        if (positions[user].debt == 0) {
            positions[user].hf = type(uint256).max;
            return positions[user].hf;
        }
        positions[user].hf =
            positions[user].collateral * vETHPrice * LIQUI_THRESHOLD /
            (100 * positions[user].debt);
        return positions[user].hf;
    }

    /// @notice Admin: recalculate every position and liquidate those at or below HF 1.00.
    function checkAllHF() public onlyRole(ADMIN_ROLE) {
        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            calcHF(user);
            if (positions[user].hf <= 100) {
                liquidateUser(user);
            }
        }
    }

    /// @notice Partial liquidation: repay enough debt to restore the position to MAX_LTV,
    ///         seizing collateral worth (debt_repaid + LIQUI_PENALTY%).
    ///         Falls back to full closure if collateral is insufficient.
    function liquidateUser(address user) internal {
        // Collateral value in vUSD units
        uint256 collateralValue = positions[user].collateral * vETHPrice / 100;
        uint256 D = positions[user].debt;

        // Debt to repay = current debt − target debt at MAX_LTV
        // target_debt = collateral_value × MAX_LTV / 100
        uint256 targetDebt = collateralValue * MAX_LTV / 100;
        if (targetDebt >= D) return; // Position is already safe (defensive guard)

        uint256 debtToRepay = D - targetDebt;

        // Collateral to seize = repaid debt value × (1 + LIQUI_PENALTY / 100)
        // Converted from vUSD units to vETH units (ceiling division)
        uint256 seizeValueVUSD = debtToRepay * (100 + LIQUI_PENALTY) / 100;
        uint256 collateralToSeize = (seizeValueVUSD * 100 + vETHPrice - 1) / vETHPrice;

        // If collateral is insufficient, seize everything and close the position
        if (collateralToSeize > positions[user].collateral) {
            collateralToSeize = positions[user].collateral;
            debtToRepay = D;
        }

        _updateDebtTime(user);
        positions[user].debt -= debtToRepay;
        positions[user].collateral -= collateralToSeize;
        calcHF(user);

        emit Liquidated(user, debtToRepay, collateralToSeize);
    }

    // -------------------------------------------------------------------------
    // Viewers
    // -------------------------------------------------------------------------

    /// @notice Return the full position of a given participant.
    function getUserPosition(address user) external view returns (userPosition memory) {
        return positions[user];
    }

    /// @notice Return all registered participant addresses.
    function listUsers() external view returns (address[] memory) {
        address[] memory list = new address[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            list[i] = users[i];
        }
        return list;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Admin: open the challenge so participants can join.
    function open() external onlyRole(ADMIN_ROLE) {
        challengeOpen = true;
        emit ChallengeOpened();
    }

    /// @notice Admin: close registration — join() will revert after this.
    function close() external onlyRole(ADMIN_ROLE) {
        challengeOpen = false;
        emit ChallengeClosed();
    }

    /// @notice Admin: mark the official scenario start. All debt-time scoring
    ///         begins from this timestamp regardless of when each user joined.
    function start() external onlyRole(ADMIN_ROLE) {
        require(scenarioStartTime == 0, "Scenario already started");
        scenarioStartTime = block.timestamp;
        emit ChallengeStarted(block.timestamp);
    }

    /// @notice Admin: end the scenario. Flushes every participant's pending
    ///         debt-time and computes their final loan-continuity score (0–10000 bp).
    function stop() external onlyRole(ADMIN_ROLE) {
        require(scenarioStartTime > 0, "Scenario not started");
        require(scenarioEndTime == 0, "Scenario already stopped");
        scenarioEndTime = block.timestamp;
        uint256 duration = scenarioEndTime - scenarioStartTime;
        emit ChallengeStopped(scenarioEndTime, duration);

        if (duration == 0 || start_Debt == 0) return;
        uint256 maxDebtTime = start_Debt * duration;

        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            _updateDebtTime(user); // flush pending debt × time up to scenarioEndTime
            uint256 score = positions[user].cumulativeDebtTime * 10000 / maxDebtTime;
            if (score > 10000) score = 10000; // cap at 100%
            loanContinuityScore[user] = score;
            emit LoanContinuityScored(user, score);
        }
    }

    function updatevETHPrice(uint256 price) external onlyRole(ADMIN_ROLE) {
        emit PriceUpdate(vETHPrice, price);
        vETHPrice = price;
    }

    /// @notice Withdraw tokens that are stuck in the contract.
    function rescueTokens(address token, uint256 amount) external onlyRole(ADMIN_ROLE) {
        TokenInterface(token).transfer(msg.sender, amount);
    }
}
