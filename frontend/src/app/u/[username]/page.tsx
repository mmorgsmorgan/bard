'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { useReadContract } from 'wagmi';
import { CONTRACTS, VOUCH_TIERS } from '@/lib/config';
import { BARD_PROFILE_ABI, BARD_VOUCH_ABI, BARD_AGENT_ABI } from '@/lib/abi';
import { fetchProfileByUsername, fetchProofsByWallet, fetchPortfolioByWallet, fetchAgentsByOwner, type StoredProfile, type StoredProof, type PortfolioItem, type Agent } from '@/lib/store';
import Link from 'next/link';
import { GitHubIcon, DiscordIcon, FarcasterIcon, XIcon, LinkedInIcon } from '@/components/SocialIcons';
import { Headline } from '@/components/Editorial';
import { useBardAccount } from '@/components/BardAccountProvider';

export default function PublicProfilePage() {
  const params = useParams();
  const username = params.username as string;
  const {
    address: viewerAddress,
    isConnected,
    authReady,
    status,
    login,
    authFetch,
    sendTransaction,
  } = useBardAccount();

  const [localProfile, setLocalProfile] = useState<StoredProfile | null>(null);
  const [proofs, setProofs] = useState<StoredProof[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [linkedAgents, setLinkedAgents] = useState<Agent[]>([]);
  const [expandedItem, setExpandedItem] = useState<PortfolioItem | null>(null);
  const [showVouchModal, setShowVouchModal] = useState(false);
  const [showVouchersModal, setShowVouchersModal] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [vouchTier, setVouchTier] = useState(0);
  const [vouchAmount, setVouchAmount] = useState('1');
  const [vouchStatement, setVouchStatement] = useState('');
  const [vouchEcosystem, setVouchEcosystem] = useState('');
  const [vouchScore, setVouchScore] = useState('80');
  const [vouchStep, setVouchStep] = useState<'form' | 'vouching' | 'done' | 'error'>('form');
  const [vouchError, setVouchError] = useState('');
  const [vouchExplorer, setVouchExplorer] = useState('');
  const [pendingApproveTxHash, setPendingApproveTxHash] = useState('');
  const [pendingVouchTxHash, setPendingVouchTxHash] = useState('');

  const { data: onChainProfile, isError: profileReadError, isLoading: profileLoading } = useReadContract({
    address: CONTRACTS.BARD_PROFILE, abi: BARD_PROFILE_ABI, functionName: 'getProfileByUsername', args: [username],
  });

  // PFP is stored as a regular image URL in the profile, not as an NFT

  const profileWalletForPFP = onChainProfile && !profileReadError && Array.isArray(onChainProfile)
    ? (onChainProfile[0] as `0x${string}`) : undefined;

  // Read agent data
  const { data: agentData } = useReadContract({
    address: CONTRACTS.BARD_AGENT, abi: BARD_AGENT_ABI, functionName: 'getAgent',
    args: profileWalletForPFP ? [profileWalletForPFP] : undefined,
    query: { enabled: !!profileWalletForPFP },
  });

  // Read vouch stats
  const profileContributorId = profileWalletForPFP ? BigInt(profileWalletForPFP) : undefined;
  const { data: vouchCountData, refetch: refetchVouchCount } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'getVouchCount',
    args: profileContributorId !== undefined ? [profileContributorId] : undefined,
    query: { enabled: profileContributorId !== undefined },
  });
  const { data: totalStakedData, refetch: refetchTotalStaked } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'totalStakedForContributor',
    args: profileContributorId !== undefined ? [profileContributorId] : undefined,
    query: { enabled: profileContributorId !== undefined },
  });
  const vouchCount = vouchCountData ? Number(vouchCountData) : 0;
  const totalStaked = totalStakedData ? Number(totalStakedData) / 1_000_000 : 0;

  useEffect(() => {
    fetchProfileByUsername(username).then(p => {
      setLocalProfile(p);
      if (p) {
        fetchProofsByWallet(p.wallet).then(setProofs);
        fetchPortfolioByWallet(p.wallet).then(setPortfolio);
      }
      setLoaded(true);
    });
  }, [username]);

  // Fetch linked agents when wallet is known
  useEffect(() => {
    const wallet = localProfile?.wallet || profileWalletForPFP;
    if (wallet) {
      fetchAgentsByOwner(wallet).then(agents => setLinkedAgents(agents || []));
    }
  }, [localProfile, profileWalletForPFP]);

  // When on-chain profile loads but no localStorage data, load portfolio/proofs by wallet
  useEffect(() => {
    if (!localProfile && onChainProfile && Array.isArray(onChainProfile)) {
      const wallet = onChainProfile[0] as string;
      if (wallet && wallet !== '0x0000000000000000000000000000000000000000') {
        fetchProofsByWallet(wallet).then(setProofs);
        fetchPortfolioByWallet(wallet).then(setPortfolio);
      }
    }
  }, [onChainProfile, localProfile]);

  const handleVouch = async () => {
    if (!isConnected || !profileWallet) return;
    const amountNumber = Number(vouchAmount);
    const scoreNumber = Number(vouchScore);
    if (!Number.isFinite(amountNumber) || amountNumber < VOUCH_TIERS[vouchTier].minUSDC) {
      setVouchStep('error');
      setVouchError(`Tier minimum is ${VOUCH_TIERS[vouchTier].minUSDC} USDC`);
      return;
    }
    if (!Number.isFinite(scoreNumber) || scoreNumber < 0 || scoreNumber > 100) {
      setVouchStep('error');
      setVouchError('Score must be between 0 and 100');
      return;
    }
    setVouchStep('vouching');
    setVouchError('');
    try {
      const vouchInput = {
        contributorWallet: profileWallet,
        amount: vouchAmount,
        tier: vouchTier,
        statement: vouchStatement,
        ecosystem: vouchEcosystem,
        score: scoreNumber,
      };
      let response = await authFetch('/api/human/vouches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...vouchInput,
          ...(pendingApproveTxHash ? { approveTxHash: pendingApproveTxHash } : {}),
          ...(pendingVouchTxHash ? { vouchTxHash: pendingVouchTxHash } : {}),
        }),
      });
      let data = await response.json() as {
        explorer?: string;
        error?: string;
        signatureRequired?: boolean;
        stage?: 'approve' | 'vouch';
        approveTxHash?: string;
        transaction?: Parameters<typeof sendTransaction>[0];
      };
      let approveTxHash = pendingApproveTxHash;
      if (
        response.status === 202 &&
        data.signatureRequired &&
        data.stage === 'approve' &&
        data.transaction
      ) {
        approveTxHash = await sendTransaction(data.transaction);
        setPendingApproveTxHash(approveTxHash);
        response = await authFetch('/api/human/vouches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...vouchInput, approveTxHash }),
        });
        data = await response.json();
      }
      if (
        response.status === 202 &&
        data.signatureRequired &&
        data.stage === 'vouch' &&
        data.transaction
      ) {
        approveTxHash = data.approveTxHash || approveTxHash;
        const vouchTxHash = await sendTransaction(data.transaction);
        setPendingVouchTxHash(vouchTxHash);
        response = await authFetch('/api/human/vouches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...vouchInput, approveTxHash, vouchTxHash }),
        });
        data = await response.json();
      }
      if (!response.ok) throw new Error(data.error || 'Vouch failed');
      setVouchExplorer(data.explorer || '');
      setPendingApproveTxHash('');
      setPendingVouchTxHash('');
      setVouchStep('done');
      await Promise.all([refetchVouchCount(), refetchTotalStaked()]);
    } catch (cause) {
      setVouchStep('error');
      setVouchError(cause instanceof Error ? cause.message.slice(0, 180) : 'Vouch failed');
    }
  };

  const profileWallet = onChainProfile && !profileReadError
    ? (Array.isArray(onChainProfile) ? (onChainProfile[0] as string) : null)
    : localProfile?.wallet;
  const profileName = localProfile?.displayName || (onChainProfile && Array.isArray(onChainProfile) ? (onChainProfile[1] as string) : username);
  const profileType = localProfile?.profileType || (onChainProfile && Array.isArray(onChainProfile) && Number(onChainProfile[3]) === 1 ? 'agent' : 'human');
  const profileBio = localProfile?.bio || '';
  const profileEcosystems = localProfile?.ecosystems || [];
  const profileFarcaster = localProfile?.farcaster || '';
  const profileGithub = localProfile?.github || '';
  const profileX = localProfile?.x || '';
  const profileDiscord = localProfile?.discord || '';
  const profileLinkedin = localProfile?.linkedin || '';
  const hasProfile = !!(profileWallet && profileWallet !== '0x0000000000000000000000000000000000000000');

  // Get PFP URL from local profile storage
  const pfpUrl = localProfile?.pfp || '';
  const hasPendingVouch = Boolean(pendingApproveTxHash || pendingVouchTxHash);

  const socialLinks = [
    profileFarcaster && { label: 'Farcaster', value: profileFarcaster, url: `https://warpcast.com/${profileFarcaster}`, icon: <FarcasterIcon /> },
    profileGithub && { label: 'GitHub', value: profileGithub, url: `https://github.com/${profileGithub}`, icon: <GitHubIcon /> },
    profileX && { label: 'X', value: profileX.replace('@', ''), url: `https://x.com/${profileX.replace('@', '')}`, icon: <XIcon /> },
    profileDiscord && { label: 'Discord', value: profileDiscord, icon: <DiscordIcon /> },
    profileLinkedin && { label: 'LinkedIn', value: profileLinkedin, url: `https://linkedin.com/${profileLinkedin}`, icon: <LinkedInIcon /> },
  ].filter(Boolean) as { label: string; value: string; url?: string; icon: React.ReactNode }[];

  if (!loaded || profileLoading) return <div className="max-w-4xl mx-auto px-6 py-24 text-center"><div className="font-mono text-surface-500 animate-pulse-subtle">Loading...</div></div>;

  if (!hasProfile && !localProfile) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-16 animate-fade-in">
          <div className="font-mono text-2xl text-surface-600 mb-6">?</div>
          <h1 className="text-xl font-bold text-white mb-3 font-mono">@{username}</h1>
          <p className="text-surface-400 text-sm mb-8">This profile hasn&apos;t been created yet.</p>
          <Link href="/profile" className="btn-primary text-xs">Claim This Profile</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">

      {/* ─── Profile Header with PFP Background ─── */}
      <div className="relative border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] overflow-hidden mb-px animate-fade-in">

        {/* Faded PFP Background */}
        {pfpUrl && (
          <div className="absolute inset-0 z-0">
            <img src={pfpUrl} alt="" className="w-full h-full object-cover opacity-[0.06] blur-sm scale-110" />
            <div className="absolute inset-0 bg-gradient-to-b from-[#0c0c0c]/40 via-transparent to-[#0c0c0c]" />
          </div>
        )}

        <div className="relative z-10 p-8">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            {/* PFP Avatar */}
            {pfpUrl ? (
              <div className="w-20 h-20 border border-[rgba(255,133,18,0.2)] shrink-0 overflow-hidden">
                <img src={pfpUrl} alt="PFP" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="w-20 h-20 bg-[#141414] border border-[rgba(255,133,18,0.2)] flex items-center justify-center text-3xl font-bold text-[#ff8512] font-mono shrink-0">
                {profileName.charAt(0).toUpperCase()}
              </div>
            )}

            {/* Profile Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <Headline size="2rem">{profileName}</Headline>
                <span className={profileType === 'human' ? 'badge-human' : 'badge-agent'}>{profileType}</span>
              </div>
              <div className="font-mono text-sm text-[#ff8512] mb-3">@{username}</div>
              {profileBio && <p className="text-sm text-surface-400 leading-relaxed max-w-xl">{profileBio}</p>}

              {/* Ecosystems */}
              {profileEcosystems.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-4">
                  {profileEcosystems.map((eco) => (
                    <span key={eco} className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-[10px] text-surface-400 tracking-wider">{eco}</span>
                  ))}
                </div>
              )}

              {/* Social Links */}
              {socialLinks.length > 0 && (
                <div className="flex flex-wrap gap-3 mt-4">
                  {socialLinks.map((link) => (
                    link.url ? (
                      <a key={link.label} href={link.url} target="_blank" rel="noopener noreferrer"
                         className="flex items-center gap-1.5 px-3 py-1 border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,133,18,0.3)] transition-colors group">
                        <span className="text-xs text-surface-400">{link.icon}</span>
                        <span className="font-mono text-[10px] text-surface-400 group-hover:text-[#ff8512] transition-colors">{link.value}</span>
                      </a>
                    ) : (
                      <span key={link.label} className="flex items-center gap-1.5 px-3 py-1 border border-[rgba(255,255,255,0.06)]">
                        <span className="text-xs text-surface-400">{link.icon}</span>
                        <span className="font-mono text-[10px] text-surface-400">{link.value}</span>
                      </span>
                    )
                  ))}
                </div>
              )}
            </div>

            {/* Vouches Count - clickable */}
            <div className="shrink-0 text-center">
              <button
                onClick={() => setShowVouchersModal(true)}
                className="group cursor-pointer hover:opacity-80 transition-opacity"
                title="Click to see vouchers"
              >
                <div className="w-16 h-16 border border-[rgba(255,255,255,0.06)] bg-[#050505] flex items-center justify-center mx-auto mb-1 group-hover:border-[rgba(255,133,18,0.3)] transition-colors">
                  <span className="font-mono text-xl font-bold text-white">{vouchCount}</span>
                </div>
                <div className="font-mono text-[9px] text-surface-500 tracking-[0.15em] group-hover:text-[#ff8512] transition-colors">VOUCHES</div>
                {totalStaked > 0 && (
                  <div className="font-mono text-[9px] text-[#ff8512] mt-0.5">{totalStaked.toFixed(0)} USDC</div>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Inline Stats Bar */}
        <div className="relative z-10 grid grid-cols-3 gap-px bg-[rgba(255,255,255,0.04)]">
          {[
            { label: 'WORKS', value: String(portfolio.length) },
            { label: 'PROOFS', value: String(proofs.length) },
            { label: 'AGENTS', value: String(linkedAgents.length) },
          ].map((s) => (
            <div key={s.label} className="bg-[#080808] p-3 text-center">
              <span className="font-mono text-sm font-bold text-white">{s.value}</span>
              <span className="font-mono text-[9px] text-surface-600 tracking-[0.15em] ml-2">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Vouch CTA */}
      {isConnected && viewerAddress?.toLowerCase() !== profileWallet?.toLowerCase() && (
        <div className="flex gap-px mb-px">
          <button onClick={() => setShowVouchModal(true)} className="btn-primary flex-1 py-3.5 text-xs">
            Vouch for {profileName}
          </button>
          <Link href={`/send?to=${username}`} className="btn-secondary flex-1 py-3.5 text-xs text-center">
            Send USDC
          </Link>
        </div>
      )}
      {!isConnected && (
        <div className="flex items-center justify-between gap-4 border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-4 mb-px">
          <span className="text-sm text-surface-400">Sign in to vouch or send USDC.</span>
          <button onClick={login} disabled={authReady && status === 'connecting'} className="btn-primary shrink-0 text-xs px-5 py-2.5">
            {authReady && status === 'connecting' ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      )}

      {/* Linked Agents */}
      {linkedAgents.length > 0 && (
        <div className="border border-[rgba(168,85,247,0.15)] bg-[rgba(168,85,247,0.03)] p-5 mb-px">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-mono text-xs text-purple-400">&#x2B21;</span>
            <span className="font-mono text-[10px] text-white uppercase tracking-wider">
              Linked Agent{linkedAgents.length > 1 ? 's' : ''} ({linkedAgents.length})
            </span>
          </div>
          <div className="space-y-2">
            {linkedAgents.map(a => (
              <Link
                key={a.id}
                href={`/agents/${a.id}`}
                className="flex items-center justify-between p-3 bg-[rgba(168,85,247,0.04)] border border-[rgba(168,85,247,0.1)] hover:border-[rgba(168,85,247,0.3)] hover:bg-[rgba(168,85,247,0.08)] transition-all group"
              >
                <div className="flex items-center gap-3">
                  <span className="w-8 h-8 flex items-center justify-center bg-[rgba(168,85,247,0.1)] border border-[rgba(168,85,247,0.2)] font-mono text-purple-400 text-xs font-bold group-hover:bg-[rgba(168,85,247,0.2)] transition-colors">
                    {a.agentName?.charAt(0)?.toUpperCase() || '?'}
                  </span>
                  <div>
                    <div className="font-mono text-xs text-white group-hover:text-purple-300 transition-colors">{a.agentName}</div>
                    <div className="font-mono text-[9px] text-surface-500">{a.agentType} · rep: {a.reputationScore}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] text-green-400">&#9679; {a.status}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-600 group-hover:text-purple-400 transition-colors">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ─── PROOF OF WORK — Main Content ─── */}
      <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] mt-px">

        {/* Portfolio Showcase */}
        {portfolio.length > 0 && (
          <div className="p-6 border-b border-[rgba(255,255,255,0.04)]">
            <div className="flex items-center gap-3 mb-5">
              <div className="accent-line" />
              <span className="font-mono text-[10px] text-surface-500 tracking-[0.15em] uppercase">Portfolio</span>
              <span className="font-mono text-[10px] text-surface-600">{portfolio.length} works</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {portfolio.map((item) => (
                <div key={item.id}
                  className="group relative bg-[#050505] border border-[rgba(255,255,255,0.04)] overflow-hidden cursor-pointer hover:border-[rgba(255,133,18,0.3)] transition-all duration-300"
                  onClick={() => setExpandedItem(item)}>
                  <div className="aspect-[4/3] bg-[#0a0a0a] overflow-hidden">
                    {item.imageDataURI ? (
                      <img src={item.imageDataURI} alt={item.title}
                        className="w-full h-full object-cover opacity-60 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="font-mono text-3xl text-surface-700 group-hover:text-[#ff8512] transition-colors">{item.category[0].toUpperCase()}</span>
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-1">
                      <h3 className="text-sm font-medium text-white group-hover:text-[#ff8512] transition-colors truncate flex-1 pr-2">{item.title}</h3>
                      <span className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-[9px] text-surface-500 uppercase shrink-0">{item.category}</span>
                    </div>
                    {item.description && <p className="text-xs text-surface-500 line-clamp-2">{item.description}</p>}
                    {item.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {item.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 bg-[rgba(255,255,255,0.03)] font-mono text-[9px] text-surface-600">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Proof of Work */}
        <div className="p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="accent-line" />
            <span className="font-mono text-[10px] text-surface-500 tracking-[0.15em] uppercase">Proof of Work</span>
            <span className="font-mono text-[10px] text-surface-600">{proofs.length} proofs</span>
          </div>
          {proofs.length === 0 ? (
            <div className="p-12 text-center border border-[rgba(255,255,255,0.04)] bg-[#050505]">
              <div className="font-mono text-surface-600 text-sm mb-2">No proofs submitted yet</div>
              <div className="font-mono text-[10px] text-surface-700">Proofs of work verify contributions on-chain</div>
            </div>
          ) : (
            <div className="space-y-3">
              {proofs.map((proof) => (
                <div key={proof.id} className="p-5 bg-[#050505] border border-[rgba(255,255,255,0.04)] hover:border-[rgba(255,133,18,0.15)] transition-colors">
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="text-sm font-medium text-white flex-1 pr-3">{proof.title}</h3>
                    <span className={`text-xs px-2 py-0.5 shrink-0 font-mono border ${
                      proof.status === 'validated' ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5' :
                      proof.status === 'pending' ? 'text-yellow-400 border-yellow-500/20 bg-yellow-500/5' :
                      'text-surface-400 border-[rgba(255,255,255,0.06)]'
                    }`}>{proof.status}</span>
                  </div>
                  {proof.description && (
                    <p className="text-xs text-surface-500 mb-3 leading-relaxed">{proof.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-surface-400">{proof.ecosystem}</span>
                    <span className="font-mono text-surface-500">{proof.contributionType}</span>
                    {proof.evidenceLink && (
                      <a href={proof.evidenceLink} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-[#ff8512] hover:underline ml-auto">
                        View Evidence
                      </a>
                    )}
                  </div>
                  {proof.proofFileURI && (
                    <div className="mt-3 border border-[rgba(255,255,255,0.04)] overflow-hidden">
                      {proof.proofFileURI.startsWith('data:video') ? (
                        <video src={proof.proofFileURI} controls className="w-full max-h-48 object-contain bg-black" />
                      ) : (
                        <img src={proof.proofFileURI} alt="Proof" className="w-full max-h-48 object-contain bg-[#0a0a0a]" />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Expanded Portfolio Item Modal ─── */}
      {expandedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setExpandedItem(null)}>
          <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />
          <div className="relative z-10 max-w-2xl w-full bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] animate-fade-in" onClick={(e) => e.stopPropagation()}>
            {expandedItem.imageDataURI && (
              <div className="w-full aspect-video bg-[#111] overflow-hidden">
                <img src={expandedItem.imageDataURI} alt={expandedItem.title} className="w-full h-full object-contain" />
              </div>
            )}
            <div className="p-8">
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-xl font-bold text-white flex-1">{expandedItem.title}</h2>
                <span className="px-3 py-1 border border-[rgba(255,133,18,0.2)] font-mono text-[10px] text-[#ff8512] uppercase">{expandedItem.category}</span>
              </div>
              {expandedItem.description && <p className="text-sm text-surface-400 mb-6 leading-relaxed">{expandedItem.description}</p>}
              {expandedItem.tags.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-6">
                  {expandedItem.tags.map(tag => (
                    <span key={tag} className="px-2 py-1 border border-[rgba(255,255,255,0.06)] font-mono text-[10px] text-surface-400">{tag}</span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-4">
                {expandedItem.githubRepo && (
                  <a
                    href={expandedItem.githubRepo.startsWith('http') ? expandedItem.githubRepo : `https://${expandedItem.githubRepo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary text-xs px-5 py-2"
                  >
                    GitHub Repo
                  </a>
                )}
                {expandedItem.externalLink && (
                  <a href={expandedItem.externalLink} target="_blank" rel="noopener noreferrer" className="btn-primary text-xs px-5 py-2">
                    {expandedItem.category === 'code' ? 'View Demo' : 'View Project'}
                  </a>
                )}
                <button onClick={() => setExpandedItem(null)} className="btn-secondary text-xs px-5 py-2">Close</button>
                <span className="text-[10px] text-surface-600 font-mono ml-auto">{new Date(expandedItem.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Vouchers Modal ─── */}
      {showVouchersModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setShowVouchersModal(false)} />
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] p-8 w-full max-w-md relative z-10 animate-slide-up">
            <h2 className="text-lg font-bold text-white mb-2">Vouchers for {profileName}</h2>
            <p className="font-mono text-xs text-surface-500 mb-6">{vouchCount} vouches · {totalStaked.toFixed(2)} USDC staked</p>

            {vouchCount === 0 ? (
              <div className="p-8 text-center border border-[rgba(255,255,255,0.04)] bg-[#050505]">
                <div className="font-mono text-surface-600 text-sm">No vouches yet</div>
                <div className="font-mono text-[10px] text-surface-700 mt-1">Be the first to vouch for this contributor</div>
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                <div className="p-4 bg-[#050505] border border-[rgba(255,255,255,0.04)] text-center">
                  <div className="font-mono text-3xl font-bold text-[#ff8512] mb-2">{vouchCount}</div>
                  <div className="font-mono text-xs text-surface-500">on-chain vouches</div>
                  {totalStaked > 0 && (
                    <div className="font-mono text-sm text-white mt-2">{totalStaked.toFixed(2)} USDC total staked</div>
                  )}
                </div>
              </div>
            )}

            <button onClick={() => setShowVouchersModal(false)} className="btn-secondary w-full mt-6 text-xs">Close</button>
          </div>
        </div>
      )}

      {/* ─── Vouch Modal ─── */}
      {showVouchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => { setShowVouchModal(false); setVouchStep('form'); }} />
          <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] p-8 w-full max-w-lg relative z-10 animate-slide-up">
            {vouchStep === 'done' ? (
              <div className="text-center">
                <div className="w-12 h-12 bg-[#ff8512] flex items-center justify-center mx-auto mb-6 text-[#050505] font-mono font-bold">&#10003;</div>
                <h2 className="text-xl font-bold text-white mb-3">Vouch Confirmed</h2>
                <p className="text-sm text-surface-400 mb-6">{vouchAmount} USDC vouch for {profileName} is live on Arc.</p>
                {vouchExplorer && (
                  <a href={vouchExplorer} target="_blank" rel="noreferrer" className="font-mono text-xs text-surface-500 hover:text-[#ff8512] underline mb-6 block">
                    View transaction ↗
                  </a>
                )}
                <button
                  onClick={() => {
                    setShowVouchModal(false);
                    setVouchStep('form');
                    setPendingApproveTxHash('');
                    setPendingVouchTxHash('');
                  }}
                  className="btn-primary text-xs"
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <h2 className="text-xl font-bold text-white mb-6">Vouch for {profileName}</h2>
                <span className="label-mono block mb-3">Tier</span>
                <div className="grid grid-cols-4 gap-px bg-[rgba(255,255,255,0.06)] mb-6">
                  {VOUCH_TIERS.map((tier) => (
                    <button
                      key={tier.id}
                      disabled={hasPendingVouch}
                      onClick={() => { setVouchTier(tier.id); setVouchAmount(String(tier.minUSDC)); }}
                      className={`p-3 text-center transition-all ${vouchTier === tier.id ? 'bg-[rgba(255,133,18,0.1)] border-b-2 border-[#ff8512]' : 'bg-[#050505] hover:bg-[#0c0c0c]'}`}>
                      <div className="font-mono text-xs font-bold text-white">{tier.name}</div>
                      <div className="font-mono text-[10px] text-surface-500">{tier.multiplier}</div>
                    </button>
                  ))}
                </div>

                <div className="space-y-5">
                  <div>
                    <span className="label-mono block mb-2">Stake (USDC)</span>
                    <input disabled={hasPendingVouch} type="number" value={vouchAmount} onChange={(e) => setVouchAmount(e.target.value)} min={VOUCH_TIERS[vouchTier].minUSDC} className="input-field font-mono" />
                    <p className="font-mono text-[10px] text-surface-600 mt-1">Min: {VOUCH_TIERS[vouchTier].minUSDC} USDC -- 30-day lock</p>
                  </div>
                  <div>
                    <span className="label-mono block mb-2">Statement</span>
                    <textarea disabled={hasPendingVouch} value={vouchStatement} onChange={(e) => setVouchStatement(e.target.value)} placeholder="Why do you vouch for this contributor?" className="input-field" rows={2} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <span className="label-mono block mb-2">Ecosystem</span>
                      <input disabled={hasPendingVouch} value={vouchEcosystem} onChange={(e) => setVouchEcosystem(e.target.value)} placeholder="Arc, Monad..." className="input-field" />
                    </div>
                    <div>
                      <span className="label-mono block mb-2">Score (0-100)</span>
                      <input disabled={hasPendingVouch} type="number" value={vouchScore} onChange={(e) => setVouchScore(e.target.value)} min="0" max="100" className="input-field font-mono" />
                    </div>
                  </div>
                </div>

                {vouchError && <div className="mt-4 p-3 bg-red-900/20 border border-red-900/30 text-red-400 text-sm font-mono">{vouchError}</div>}
                {hasPendingVouch && (
                  <div className="mt-4 p-3 border border-[rgba(255,133,18,0.25)] bg-[rgba(255,133,18,0.05)] text-surface-400 text-xs font-mono">
                    BARD will reuse the pending transaction hash instead of creating another stake.
                  </div>
                )}

                <div className="flex gap-3 mt-8">
                  <button onClick={() => { setShowVouchModal(false); setVouchStep('form'); }} className="btn-secondary flex-1 text-xs">Cancel</button>
                  <button onClick={handleVouch} disabled={!vouchStatement || !vouchEcosystem || vouchStep === 'vouching'} className="btn-primary flex-1 text-xs">
                    {vouchStep === 'vouching'
                      ? 'Confirming...'
                      : hasPendingVouch
                        ? 'Resume vouch'
                        : `Vouch ${vouchAmount} USDC`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
