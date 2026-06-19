// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {BardJobHook} from "../src/BardJobHook.sol";
import {ERC8183} from "../src/vendor/ERC8183.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title DeployBardEscrow
 * @notice Deploys the BARD escrow stack: ERC-8183 (AgenticCommerce) + BardJobHook.
 *
 *  Two paths via env vars:
 *    AGENTIC_COMMERCE — if set, treated as the existing AC address (Path A).
 *                       The script only deploys BardJobHook and prints the
 *                       whitelist/allowlist tx the admin still needs to send.
 *    (unset)           — Path B: deploys ERC8183 behind an ERC-1967 proxy,
 *                       allowlists USDC, whitelists the hook.
 *
 *  Env vars (Path B):
 *    PAYMENT_TOKEN     — required; defaults to Arc testnet USDC.
 *    TREASURY          — required; platform fee treasury on the standard.
 *    ADMIN             — required; ERC-8183 admin role (Safe in prod).
 *    REPUTATION_READER — optional; ERC-8004 reader adapter (else address(0)).
 *
 *  Run:
 *    forge script script/DeployEscrow.s.sol \
 *      --rpc-url $ARC_RPC \
 *      --broadcast \
 *      --private-key $DEPLOYER_PK
 */
contract DeployBardEscrow is Script {
    // Arc testnet defaults (Bard).
    address internal constant DEFAULT_PAYMENT_TOKEN = 0x3600000000000000000000000000000000000000;

    function run() external {
        address paymentToken = _envOr("PAYMENT_TOKEN", DEFAULT_PAYMENT_TOKEN);
        address treasury     = _envAddrRequired("TREASURY");
        address admin        = _envAddrRequired("ADMIN");
        address reader       = vm.envOr("REPUTATION_READER", address(0));
        address existingAC   = vm.envOr("AGENTIC_COMMERCE", address(0));

        vm.startBroadcast();

        address agenticCommerce;

        if (existingAC == address(0)) {
            // ── Path B: deploy our own ERC-8183 proxy.
            ERC8183 impl = new ERC8183();
            bytes memory initCall = abi.encodeWithSelector(
                ERC8183.initialize.selector,
                treasury,
                admin
            );
            ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
            agenticCommerce = address(proxy);

            console.log("ERC8183 impl  :", address(impl));
            console.log("ERC8183 proxy :", agenticCommerce);
        } else {
            agenticCommerce = existingAC;
            console.log("Using existing AgenticCommerce:", agenticCommerce);
        }

        // ── Deploy the hook.
        BardJobHook hook = new BardJobHook(agenticCommerce, paymentToken, reader);
        console.log("BardJobHook   :", address(hook));
        console.log("paymentToken  :", paymentToken);
        console.log("reputationReader:", reader);

        // ── Path B: configure as part of the deployment.
        if (existingAC == address(0)) {
            // Caller of the script must hold ADMIN_ROLE on ERC8183. With
            // initialize(treasury, admin) the admin parameter does, so the
            // typical deploy flow is: deployer == admin for bootstrap, then
            // transfer admin role to a Safe afterwards.
            if (msg.sender == admin) {
                ERC8183(agenticCommerce).setPaymentTokenAllowed(paymentToken, true);
                ERC8183(agenticCommerce).setHookWhitelist(address(hook), true);
                console.log("USDC allowlisted and hook whitelisted");
            } else {
                console.log("Skipping admin actions; deployer is not admin.");
                console.log("Admin must call:");
                console.log("  ac.setPaymentTokenAllowed(paymentToken, true)");
                console.log("  ac.setHookWhitelist(hook, true)");
            }
        } else {
            console.log("Admin of the existing AC must now call:");
            console.log("  ac.setPaymentTokenAllowed(paymentToken, true)");
            console.log("  ac.setHookWhitelist(hook, true)");
        }

        vm.stopBroadcast();
    }

    function _envOr(string memory key, address fallback_) internal view returns (address) {
        return vm.envOr(key, fallback_);
    }

    function _envAddrRequired(string memory key) internal view returns (address v) {
        v = vm.envAddress(key);
        require(v != address(0), string.concat(key, " env var is required"));
    }
}
