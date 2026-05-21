// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BardAgent
 * @notice Agent authentication and autonomous action framework for BARD.
 * @dev Agents register an operator address that can act on their behalf.
 *      Operators can submit proofs and perform actions without the agent's
 *      private key, enabling autonomous AI agent workflows.
 */
contract BardAgent {
    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────
    struct Agent {
        address wallet;          // Agent's main wallet
        address operator;        // Authorized operator (can act on behalf)
        string apiEndpoint;      // Agent's API endpoint (for discovery)
        string capabilities;     // Comma-separated capabilities
        uint256 registeredAt;
        uint256 proofsSubmitted;
        uint256 lastActiveAt;
        bool active;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────
    mapping(address => Agent) public agents;        // wallet => agent
    mapping(address => address) public operatorToAgent; // operator => agent wallet
    address[] public allAgents;
    uint256 public totalAgents;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event AgentRegistered(address indexed wallet, address indexed operator, string apiEndpoint, uint256 timestamp);
    event AgentUpdated(address indexed wallet, address newOperator, string newEndpoint, uint256 timestamp);
    event AgentAction(address indexed agentWallet, address indexed operator, string actionType, string data, uint256 timestamp);
    event AgentDeactivated(address indexed wallet, uint256 timestamp);

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────
    error AlreadyRegistered();
    error NotRegistered();
    error NotAuthorized();
    error OperatorAlreadyUsed();
    error InvalidOperator();

    // ──────────────────────────────────────────────
    //  External — Register Agent
    // ──────────────────────────────────────────────
    /**
     * @notice Register as an agent with an operator address.
     * @param operator Address that can act on behalf of this agent
     * @param apiEndpoint Agent's API endpoint for discovery
     * @param capabilities Comma-separated list of capabilities
     */
    function registerAgent(
        address operator,
        string memory apiEndpoint,
        string memory capabilities
    ) external {
        if (agents[msg.sender].active) revert AlreadyRegistered();
        if (operator == address(0)) revert InvalidOperator();
        if (operatorToAgent[operator] != address(0)) revert OperatorAlreadyUsed();

        agents[msg.sender] = Agent({
            wallet: msg.sender,
            operator: operator,
            apiEndpoint: apiEndpoint,
            capabilities: capabilities,
            registeredAt: block.timestamp,
            proofsSubmitted: 0,
            lastActiveAt: block.timestamp,
            active: true
        });

        operatorToAgent[operator] = msg.sender;
        allAgents.push(msg.sender);
        totalAgents++;

        emit AgentRegistered(msg.sender, operator, apiEndpoint, block.timestamp);
    }

    // ──────────────────────────────────────────────
    //  External — Agent Actions (operator or agent)
    // ──────────────────────────────────────────────
    /**
     * @notice Record an agent action. Callable by agent wallet or its operator.
     * @param actionType Type of action (e.g., "proof_submit", "vouch", "interact")
     * @param data Action-specific data
     */
    function recordAction(
        string memory actionType,
        string memory data
    ) external {
        address agentWallet = _resolveAgent(msg.sender);

        agents[agentWallet].lastActiveAt = block.timestamp;
        agents[agentWallet].proofsSubmitted++;

        emit AgentAction(agentWallet, msg.sender, actionType, data, block.timestamp);
    }

    // ──────────────────────────────────────────────
    //  External — Update Agent
    // ──────────────────────────────────────────────
    function updateAgent(
        address newOperator,
        string memory newEndpoint,
        string memory newCapabilities
    ) external {
        if (!agents[msg.sender].active) revert NotRegistered();

        // Clear old operator mapping
        address oldOperator = agents[msg.sender].operator;
        if (oldOperator != address(0)) {
            delete operatorToAgent[oldOperator];
        }

        // Set new operator
        if (newOperator != address(0)) {
            if (operatorToAgent[newOperator] != address(0)) revert OperatorAlreadyUsed();
            operatorToAgent[newOperator] = msg.sender;
        }

        agents[msg.sender].operator = newOperator;
        agents[msg.sender].apiEndpoint = newEndpoint;
        agents[msg.sender].capabilities = newCapabilities;

        emit AgentUpdated(msg.sender, newOperator, newEndpoint, block.timestamp);
    }

    function deactivateAgent() external {
        if (!agents[msg.sender].active) revert NotRegistered();
        agents[msg.sender].active = false;

        address op = agents[msg.sender].operator;
        if (op != address(0)) delete operatorToAgent[op];

        emit AgentDeactivated(msg.sender, block.timestamp);
    }

    // ──────────────────────────────────────────────
    //  View
    // ──────────────────────────────────────────────
    function getAgent(address wallet) external view returns (Agent memory) {
        return agents[wallet];
    }

    function isAgent(address wallet) external view returns (bool) {
        return agents[wallet].active;
    }

    function isOperator(address operator) external view returns (bool) {
        return operatorToAgent[operator] != address(0);
    }

    function getAgentByOperator(address operator) external view returns (Agent memory) {
        address wallet = operatorToAgent[operator];
        require(wallet != address(0), "No agent for operator");
        return agents[wallet];
    }

    // ──────────────────────────────────────────────
    //  Internal
    // ──────────────────────────────────────────────
    function _resolveAgent(address caller) internal view returns (address) {
        // Direct agent call
        if (agents[caller].active) return caller;
        // Operator call
        address agentWallet = operatorToAgent[caller];
        if (agentWallet != address(0) && agents[agentWallet].active) return agentWallet;
        revert NotAuthorized();
    }
}
