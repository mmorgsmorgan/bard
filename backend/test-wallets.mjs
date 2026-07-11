// Test-actor keys for live Arc-testnet escrow tests — sourced from env so NO private
// keys live in committed source.
//
// W1/W2/W3 are throwaway Arc-testnet EOAs used only as client/provider/evaluator in
// the direct on-chain escrow tests. After the 2026-07-10 secure escrow redeploy they
// hold NO contract authority (admin/owner/treasury moved to the platform wallet
// 0xACA613…). The original hardcoded keys were committed to git history and are
// therefore permanently BURNED — do not reuse them for anything that holds value.
//
// To run these tests, export the three keys (the burned ones still work as funded
// testnet actors, or generate + fund fresh EOAs):
//   export BARD_TEST_W1=0x...   # client / treasury actor
//   export BARD_TEST_W2=0x...   # provider actor
//   export BARD_TEST_W3=0x...   # evaluator actor

export function testKey(which) {
  const name = `BARD_TEST_${which}`;
  const v = process.env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(
      `Missing/invalid ${name}. Test-actor keys are no longer hardcoded — ` +
      `export BARD_TEST_W1/W2/W3 (see backend/test-wallets.mjs).`
    );
  }
  return v;
}

// Convenience objects mirroring the old shapes used across the test files.
export const KEYS = {
  get W1() { return testKey('W1'); },
  get W2() { return testKey('W2'); },
  get W3() { return testKey('W3'); },
};
