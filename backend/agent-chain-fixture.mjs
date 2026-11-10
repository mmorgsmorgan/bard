import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

export async function startChain(pool, env) {
  const rpc = 'http://127.0.0.1:48545';
  const child = spawn('/home/chief/.foundry/bin/anvil', ['--host','127.0.0.1','--port','48545','--chain-id','5042002','--silent'], { stdio: 'ignore' });
  const chain = { id: 5042002, name: 'Disposable Arc fixture', nativeCurrency: { name: 'gas', symbol: 'GAS', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const publicClient = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 });
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null) await once(child,'exit'); };
  try {
    let ready = false;
    for (let i=0;i<50;i++) {
      try { ready = await publicClient.getChainId() === 5042002; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r,100));
    }
    if (!ready) throw new Error('Local chain did not start.');
    const account = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({ chain, account, transport: http(rpc) });
    const gas = async address => publicClient.request({ method: 'anvil_setBalance', params: [address,'0x3635c9adc5dea00000'] });
    await gas(account.address);
    function artifact(name) { return JSON.parse(readFileSync(new URL('../contracts/out/' + name + '.sol/' + name + '.json',import.meta.url))); }
    async function deploy(name,args=[]) {
      const a = artifact(name);
      const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
      return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
    }
    const usdc = await deploy('MockUSDC');
    const implementation = await deploy('ERC8183');
    const abi = artifact('ERC8183').abi;
    const commerce = await deploy('ERC1967Proxy',[implementation,encodeFunctionData({ abi, functionName:'initialize',args:[account.address,account.address] })]);
    const hook = await deploy('BardJobHookV2',[commerce,usdc,'0x'+'00'.repeat(20),account.address]);
    async function write(address,abi,functionName,args) {
      const hash = await wallet.writeContract({ address,abi,functionName,args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Fixture transaction failed.');
    }
    await write(commerce,abi,'setPaymentTokenAllowed',[usdc,true]);
    await write(commerce,abi,'setHookWhitelist',[hook,true]);
    process.env.WALLET_MASTER_KEY = env.WALLET_MASTER_KEY;
    const { LocalWalletProvider } = await import('./wallet-provider.js');
    const signer = new LocalWalletProvider(pool);
    const platform = await signer.createWallet('disposable-evaluator');
    await gas(platform.address);
    Object.assign(env,{ ARC_TESTNET_RPC:rpc, AGENTIC_COMMERCE_ADDRESS:commerce, BARD_JOB_HOOK_ADDRESS:hook, USDC_CONTRACT_ADDRESS:usdc, SELLER_ADDRESS:platform.address, ARC_TX_PACE_MS:'0' });
    return { stop, publicClient, commerce, abi, hook,
      async fund(address, amount = 100000000n) { await gas(address); await write(usdc,artifact('MockUSDC').abi,'mint',[address,amount]); },
      async feeMeta(jobId) { return publicClient.readContract({ address: hook, abi: artifact('BardJobHookV2').abi, functionName: 'getFeeMeta', args: [BigInt(jobId)] }); },
      async balance(address) { return publicClient.readContract({ address: usdc, abi: artifact('MockUSDC').abi, functionName:'balanceOf',args:[address] }); },
    };
  } catch (err) { await stop(); throw err; }
}
