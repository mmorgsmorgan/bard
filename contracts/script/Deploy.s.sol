// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BardProfile.sol";
import "../src/BardVouch.sol";
import "../src/BardBadge.sol";
import "../src/BardPFP.sol";
import "../src/BardProof.sol";
import "../src/BardAgent.sol";

/**
 * @title Deploy all BARD contracts to Arc Testnet
 * @dev Run with: forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.network --broadcast
 */
contract DeployBard is Script {
    function run() external {
        vm.startBroadcast();

        BardProfile profile = new BardProfile();
        BardVouch vouch = new BardVouch();
        BardBadge badge = new BardBadge();
        BardPFP pfp = new BardPFP();
        BardProof proof = new BardProof();
        BardAgent agent = new BardAgent();

        console.log("=== BARD Contracts Deployed ===");
        console.log("BardProfile:", address(profile));
        console.log("BardVouch:  ", address(vouch));
        console.log("BardBadge:  ", address(badge));
        console.log("BardPFP:    ", address(pfp));
        console.log("BardProof:  ", address(proof));
        console.log("BardAgent:  ", address(agent));

        vm.stopBroadcast();
    }
}
