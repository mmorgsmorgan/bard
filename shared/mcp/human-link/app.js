/* The only credential in this page is an expiring, identity-only link capability. */
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const wallets = new Map();
let selectedWallet;
let address;
let challenge;
let ready = false;
let accountListener;

function discoverWallet(event) {
  const { info, provider } = event.detail || {};
  if (!info?.uuid || !provider?.request || wallets.has(info.uuid)) return;
  wallets.set(info.uuid, provider);
  const option = document.createElement('option');
  option.value = info.uuid;
  option.textContent = String(info.name || 'Browser wallet');
  $('wallet-select').append(option);
  $('wallet-choice').hidden = wallets.size < 2;
}
window.addEventListener('eip6963:announceProvider', discoverWallet);
window.dispatchEvent(new Event('eip6963:requestProvider'));

async function api(path, body) {
  const response = await fetch(`/api/human-links/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(25000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Verification is unavailable. Please retry.');
  return data;
}

async function prepare() {
  const providers = [...document.querySelectorAll('input[name=provider]:checked')].map(input => input.value);
  if (!providers.length) throw new Error('Choose at least one verification provider.');
  const result = await api('challenge', { wallet: address, providers });
  challenge = result;
  $('message').textContent = result.message;
  $('message-preview').hidden = false;
}

function resetWallet() {
  address = undefined;
  challenge = undefined;
  $('wallet-address').textContent = '';
  $('connect').hidden = false;
  $('sign').hidden = true;
  $('message-preview').hidden = true;
}
$('wallet-select').addEventListener('change', () => {
  resetWallet();
  status('Wallet changed. Connect it to review a new signing message.');
});
$('choices').addEventListener('change', () => { challenge = undefined; $('message-preview').hidden = true; });
$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  try {
    if (accountListener) selectedWallet?.removeListener?.('accountsChanged', accountListener);
    selectedWallet = wallets.get($('wallet-select').value) || window.ethereum;
    if (!selectedWallet?.request) throw new Error('No browser wallet was found. Open your agent’s link in a wallet browser, or install a browser wallet and reopen the link.');
    const accounts = await selectedWallet.request({ method: 'eth_requestAccounts' });
    if (!accounts?.[0]) throw new Error('No wallet account was selected.');
    address = accounts[0];
    accountListener = () => { resetWallet(); status('Wallet account changed. Connect again before signing.'); };
    selectedWallet.on?.('accountsChanged', accountListener);
    $('wallet-address').textContent = address;
    await prepare();
    $('connect').hidden = true;
    $('sign').hidden = false;
    status('Connected. Review your choices, then sign the link.');
  } catch (error) { status(error.message); }
  finally { $('connect').disabled = !ready; }
});

$('link-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('sign').disabled = true;
  $('choices').disabled = true;
  $('wallet-select').disabled = true;
  try {
    if (!address || !selectedWallet?.request) throw new Error('Connect your wallet before signing.');
    const accounts = await selectedWallet.request({ method: 'eth_accounts' });
    if (accounts?.[0]?.toLowerCase() !== address.toLowerCase()) {
      resetWallet();
      throw new Error('Wallet account changed. Connect again before signing.');
    }
    if (!challenge) await prepare();
    status('Confirm the identity-link message in your wallet.');
    const hex = '0x' + [...new TextEncoder().encode(challenge.message)].map(b => b.toString(16).padStart(2, '0')).join('');
    const signature = await selectedWallet.request({ method: 'personal_sign', params: [hex, address] });
    status('Checking your selected verification…');
    const result = await api('complete', { challengeId: challenge.challengeId, signature });
    const names = result.links.map(link => link.provider === 'ethos' ? 'Ethos' : 'Human Passport');
    $('link-form').hidden = true;
    status(`Linked with ${names.join(' and ')}. You can close this page and return to your agent.`);
  } catch (error) { status(error.code === 4001 ? 'Signature cancelled. You can retry when you’re ready.' : error.message); }
  finally { $('sign').disabled = false; $('choices').disabled = false; $('wallet-select').disabled = false; }
});

async function load() {
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Ask your agent to create a human-verification link through Bard MCP, then open that link.');
    const session = await api('session');
    $('agent-name').textContent = session.agentName;
    $('agent-id').textContent = session.agentId;
    $('passport-choice').disabled = !session.providers.passport;
    if (!session.providers.passport) $('passport-note').textContent = 'Not configured on this Bard deployment yet.';
    ready = true;
    $('choices').disabled = false;
    $('connect').disabled = false;
    status(`This link expires at ${new Date(session.expiresAt).toLocaleTimeString()}.`);
  } catch (error) { $('agent-name').textContent = 'Verification link required'; status(error.message); }
}
load();
