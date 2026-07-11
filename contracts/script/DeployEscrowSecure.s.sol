// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {BardJobHookV2} from "../src/BardJobHookV2.sol";
import {ERC8183} from "../src/vendor/ERC8183.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title DeployBardEscrowSecure
 * @notice Fresh, securely-owned redeploy of the BARD escrow stack (audit fix C-1).
 *
 *  The previous deployment's ERC8183 admin + hook owner + treasury were all a test
 *  EOA whose private key is committed to the repo — total escrow compromise. This
 *  script deploys a NEW stock ERC-8183 proxy + BardJobHookV2 and leaves ALL authority
 *  with a secure wallet (`SECURE_ADMIN`), with the bootstrap deployer fully renounced.
 *
 *  The deployer (broadcast key) is only a throwaway bootstrap: it must hold ADMIN_ROLE
 *  transiently so it can run the allowlist/whitelist config in the same tx batch, then
 *  it grants every role to SECURE_ADMIN and renounces its own. After this script the
 *  deployer key controls nothing.
 *
 *  Env vars:
 *    SECURE_ADMIN      — required; final admin/owner/treasury (e.g. platform Turnkey wallet or a Safe).
 *    PAYMENT_TOKEN     — optional; defaults to Arc testnet USDC.
 *    REPUTATION_READER — optional; ERC-8004 reader adapter (else address(0)).
 *
 *  Run:
 *    SECURE_ADMIN=0xACA613... forge script script/DeployEscrowSecure.s.sol \
 *      --rpc-url $ARC_RPC --broadcast --private-key $BOOTSTRAP_DEPLOYER_PK
 */
contract DeployBardEscrowSecure is Script {
    address internal constant DEFAULT_PAYMENT_TOKEN = 0x3600000000000000000000000000000000000000;

    function run() external {
        address paymentToken = vm.envOr("PAYMENT_TOKEN", DEFAULT_PAYMENT_TOKEN);
        address secureAdmin  = vm.envAddress("SECURE_ADMIN");
        address reader       = vm.envOr("REPUTATION_READER", address(0));
        require(secureAdmin != address(0), "SECURE_ADMIN required");

        address deployer = msg.sender;

        vm.startBroadcast();

        // ── 1. ERC-8183 (stock reference impl) behind a proxy.
        //    admin = deployer (bootstrap so inline config works); treasury = secureAdmin.
        ERC8183 impl = new ERC8183();
        bytes memory initCall = abi.encodeWithSelector(
            ERC8183.initialize.selector,
            secureAdmin,   // treasury_
            deployer       // admin_ (bootstrap, renounced below)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
        address agenticCommerce = address(proxy);

        // ── 2. Hook — owner set directly to the secure wallet at construction.
        BardJobHookV2 hook = new BardJobHookV2(agenticCommerce, paymentToken, reader, secureAdmin);

        // ── 3. Bootstrap config (deployer still holds ADMIN_ROLE here).
        ERC8183(agenticCommerce).setPaymentTokenAllowed(paymentToken, true);
        ERC8183(agenticCommerce).setHookWhitelist(address(hook), true);

        // ── 4. Hand ALL authority to secureAdmin, then renounce the bootstrap deployer.
        bytes32 adminRole        = ERC8183(agenticCommerce).ADMIN_ROLE();
        bytes32 defaultAdminRole = ERC8183(agenticCommerce).DEFAULT_ADMIN_ROLE();
        ERC8183(agenticCommerce).grantRole(defaultAdminRole, secureAdmin);
        ERC8183(agenticCommerce).grantRole(adminRole, secureAdmin);
        // renounce deployer's roles (renounceRole only affects msg.sender == deployer).
        ERC8183(agenticCommerce).renounceRole(adminRole, deployer);
        ERC8183(agenticCommerce).renounceRole(defaultAdminRole, deployer);

        vm.stopBroadcast();

        console.log("=== BARD Escrow (secure redeploy) ===");
        console.log("ERC8183 impl   :", address(impl));
        console.log("ERC8183 proxy  :", agenticCommerce);
        console.log("BardJobHookV2  :", address(hook));
        console.log("paymentToken   :", paymentToken);
        console.log("reputationReader:", reader);
        console.log("secureAdmin    :", secureAdmin);
        console.log("deployer(bootstrap, renounced):", deployer);
        console.log("");
        console.log("Set on backend:  AGENTIC_COMMERCE_ADDRESS =", agenticCommerce);
        console.log("Set on backend:  BARD_JOB_HOOK_ADDRESS    =", address(hook));
    }
}
