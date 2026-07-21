'use client';

import { useState, useEffect } from 'react';
import { useReadContract } from 'wagmi';
import { PROFILE_TYPES, CONTRACTS, CONTRIBUTION_TYPES } from '@/lib/config';
import { BARD_PROFILE_ABI, BARD_PFP_ABI, BARD_PROOF_ABI, BARD_VOUCH_ABI, IDENTITY_REGISTRY_ABI } from '@/lib/abi';
import { fetchProfileByWallet, fetchProofsByWallet, fetchPortfolioByWallet, savePortfolioItem, deletePortfolioItem, type StoredProfile, type StoredProof, type PortfolioItem } from '@/lib/store';
import Link from 'next/link';
import { BardLogo } from '@/components/BardLogo';
import { AgentAuth } from '@/components/AgentAuth';
import { LinkAgentForm } from '@/components/LinkAgentForm';
import { LinkedAgentStatus } from '@/components/LinkedAgentStatus';
import { useBardAccount } from '@/components/BardAccountProvider';

export default function ProfilePage() {
  const { address, isConnected, status, login, authFetch } = useBardAccount();
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [profileType, setProfileType] = useState<'human' | 'agent'>('human');
  const [ecosystems, setEcosystems] = useState('');
  const [farcaster, setFarcaster] = useState('');
  const [github, setGithub] = useState('');
  const [xHandle, setXHandle] = useState('');
  const [discord, setDiscord] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [existingProfile, setExistingProfile] = useState<StoredProfile | null>(null);
  const [txStatus, setTxStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [profileTxHash, setProfileTxHash] = useState('');
  const [profileExplorer, setProfileExplorer] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // PFP state
  const [pfpPreview, setPfpPreview] = useState<string | null>(null);
  const [pfpDataURI, setPfpDataURI] = useState<string | null>(null);
  const [pfpUploading, setPfpUploading] = useState(false);

  // Dashboard state (merged)
  const [activeTab, setActiveTab] = useState<'portfolio' | 'proofs' | 'vouches'>('portfolio');
  const [showAddProof, setShowAddProof] = useState(false);
  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const [proofs, setProofs] = useState<StoredProof[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [proofTitle, setProofTitle] = useState('');
  const [proofEcosystem, setProofEcosystem] = useState('');
  const [proofType, setProofType] = useState('design');
  const [proofDescription, setProofDescription] = useState('');
  const [proofLinks, setProofLinks] = useState('');

  // Portfolio form state
  const [pTitle, setPTitle] = useState('');
  const [pDescription, setPDescription] = useState('');
  const [pCategory, setPCategory] = useState<PortfolioItem['category']>('design');
  const [pLink, setPLink] = useState('');
  const [pGithub, setPGithub] = useState('');
  const [pTags, setPTags] = useState('');
  const [pImage, setPImage] = useState<string | null>(null);
  const [pImagePreview, setPImagePreview] = useState<string | null>(null);
  const [expandedItem, setExpandedItem] = useState<PortfolioItem | null>(null);

  // Settings edit state
  const [showSettings, setShowSettings] = useState(false);
  const [editBio, setEditBio] = useState('');
  const [editEcosystems, setEditEcosystems] = useState('');
  const [editFarcaster, setEditFarcaster] = useState('');
  const [editGithub, setEditGithub] = useState('');
  const [editX, setEditX] = useState('');
  const [editDiscord, setEditDiscord] = useState('');
  const [editLinkedin, setEditLinkedin] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editPfpPreview, setEditPfpPreview] = useState<string | null>(null);
  const [editPfpUrl, setEditPfpUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { data: onChainExists } = useReadContract({
    address: CONTRACTS.BARD_PROFILE, abi: BARD_PROFILE_ABI, functionName: 'profileExists',
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  const { data: onChainProfile } = useReadContract({
    address: CONTRACTS.BARD_PROFILE, abi: BARD_PROFILE_ABI, functionName: 'profiles',
    args: address ? [address] : undefined, query: { enabled: !!address && onChainExists === true },
  });

  const { data: usernameIsTaken } = useReadContract({
    address: CONTRACTS.BARD_PROFILE, abi: BARD_PROFILE_ABI, functionName: 'usernameExists',
    args: username.length >= 3 ? [username] : undefined, query: { enabled: username.length >= 3 },
  });

  // PFP reads
  const { data: existingPFP } = useReadContract({
    address: CONTRACTS.BARD_PFP, abi: BARD_PFP_ABI, functionName: 'getPFP',
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  // ERC-8004 identity check
  const { data: isIdentityRegistered } = useReadContract({
    address: CONTRACTS.IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_ABI, functionName: 'isRegistered',
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  // Vouch stats for own profile
  const ownContributorId = address ? BigInt(address) : undefined;
  const { data: ownVouchCount } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'getVouchCount',
    args: ownContributorId !== undefined ? [ownContributorId] : undefined,
    query: { enabled: ownContributorId !== undefined },
  });
  const { data: ownTotalStaked } = useReadContract({
    address: CONTRACTS.BARD_VOUCH, abi: BARD_VOUCH_ABI, functionName: 'totalStakedForContributor',
    args: ownContributorId !== undefined ? [ownContributorId] : undefined,
    query: { enabled: ownContributorId !== undefined },
  });
  const myVouchCount = ownVouchCount ? Number(ownVouchCount) : 0;
  const myTotalStaked = ownTotalStaked ? Number(ownTotalStaked) / 1_000_000 : 0;
  const identityRegistered = isIdentityRegistered === true;

  // Handle PFP file upload
  const handlePfpUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setErrorMsg('Profile image must be under 5MB'); return; }

    // Show preview immediately
    const reader = new FileReader();
    reader.onload = () => setPfpPreview(reader.result as string);
    reader.readAsDataURL(file);

    // Upload to backend
    setPfpUploading(true);
    setErrorMsg('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await authFetch('/api/upload/pfp', { method: 'POST', body: formData });
      // Surface the real server error instead of a generic message.
      let data: { success?: boolean; url?: string; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        /* non-JSON response */
      }
      if (res.ok && data.success && data.url) {
        setPfpDataURI(data.url);
      } else {
        setErrorMsg(data.error || `Upload failed (${res.status})`);
        setPfpPreview(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Could not upload image — ${msg}. Check your connection and try again.`);
      setPfpPreview(null);
    } finally {
      setPfpUploading(false);
    }
  };

  useEffect(() => {
    // Reset all per-wallet state whenever the connected wallet changes, so a
    // previously-loaded account never leaks into a different (or fresh) wallet.
    // Without this, switching to a wallet with no profile would keep showing
    // the last wallet's account and block the create-new flow.
    setExistingProfile(null);
    setSettingsLoaded(false);
    setProofs([]);
    setPortfolio([]);
    setStep(1);

    if (!address) return;

    let cancelled = false;
    fetchProfileByWallet(address).then(local => {
      if (!cancelled) setExistingProfile(local || null);
    });
    fetchProofsByWallet(address).then(p => !cancelled && setProofs(p));
    fetchPortfolioByWallet(address).then(p => !cancelled && setPortfolio(p));
    return () => { cancelled = true; };
  }, [address]);

  // Sync settings edit state when existingProfile loads
  useEffect(() => {
    if (existingProfile && !settingsLoaded) {
      setEditBio(existingProfile.bio);
      setEditEcosystems(existingProfile.ecosystems.join(', '));
      setEditFarcaster(existingProfile.farcaster || '');
      setEditGithub(existingProfile.github || '');
      setEditX(existingProfile.x || '');
      setEditDiscord(existingProfile.discord || '');
      setEditLinkedin(existingProfile.linkedin || '');
      setEditDisplayName(existingProfile.displayName);
      setEditPfpPreview(existingProfile.pfp || null);
      setEditPfpUrl(existingProfile.pfp || '');
      setSettingsLoaded(true);
    }
  }, [existingProfile, settingsLoaded]);

  // Read on-chain proofs
  const { data: onChainProofs, refetch: refetchProofs } = useReadContract({
    address: CONTRACTS.BARD_PROOF, abi: BARD_PROOF_ABI, functionName: 'getProofsByContributor',
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  useEffect(() => {
    if (onChainProfile && Array.isArray(onChainProfile) && onChainProfile[5] === true && address) {
      const synced: StoredProfile = {
        wallet: address, username: onChainProfile[1] as string,
        displayName: onChainProfile[1] as string, bio: '',
        profileType: Number(onChainProfile[3]) === 0 ? 'human' : 'agent',
        ecosystems: [], createdAt: new Date(Number(onChainProfile[4]) * 1000).toISOString(),
      };
      fetchProfileByWallet(address).then(local => {
        if (local) { synced.displayName = local.displayName; synced.bio = local.bio; synced.ecosystems = local.ecosystems; synced.farcaster = local.farcaster; synced.github = local.github; synced.x = local.x; synced.discord = local.discord; synced.linkedin = local.linkedin; synced.pfp = local.pfp; }
        setExistingProfile(synced);
      });
    }
  }, [onChainProfile, address]);

  const isValidUsername = (name: string) => /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name) && !name.includes('--');

  const handleSubmit = async () => {
    if (!isConnected || !address) return;
    setTxStatus('submitting');
    setErrorMsg('');
    try {
      const response = await authFetch('/api/human/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          displayName,
          bio,
          profileType,
          ecosystems: ecosystems.split(',').map((item) => item.trim()).filter(Boolean),
          farcaster,
          github,
          x: xHandle,
          discord,
          linkedin,
          pfp: pfpDataURI || '',
        }),
      });
      const data = await response.json() as {
        profile?: StoredProfile;
        txHash?: string;
        explorer?: string;
        error?: string;
      };
      if (!response.ok || !data.profile) {
        throw new Error(data.error || 'Profile registration failed');
      }
      setExistingProfile(data.profile);
      setProfileTxHash(data.txHash || '');
      setProfileExplorer(data.explorer || '');
      setTxStatus('done');
      setStep(3);
    } catch (err: unknown) {
      setTxStatus('error');
      setErrorMsg(err instanceof Error ? err.message.slice(0, 180) : 'Unknown error');
    }
  };

  // Proof file upload state
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofFilePreview, setProofFilePreview] = useState<string | null>(null);
  const [proofUploading, setProofUploading] = useState(false);

  const handleProofFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isVid = file.type.startsWith('video/');
    const maxSize = isVid ? 25 * 1024 * 1024 : 20 * 1024 * 1024;
    if (file.size > maxSize) { setErrorMsg(isVid ? 'Video must be under 25MB' : 'Image must be under 20MB'); return; }
    setProofFile(file);
    const reader = new FileReader();
    reader.onload = () => setProofFilePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmitProof = async () => {
    if (!address) return;
    setProofUploading(true);
    setErrorMsg('');

    try {
      let fileUrl = '';
      if (proofFile) {
        const formData = new FormData();
        formData.append('file', proofFile);
        const uploadRes = await authFetch('/api/upload/proof', { method: 'POST', body: formData });
        const uploadData = await uploadRes.json() as {
          success?: boolean;
          url?: string;
          error?: string;
        };
        if (!uploadRes.ok || !uploadData.success || !uploadData.url) {
          throw new Error(uploadData.error || 'Proof upload failed');
        }
        fileUrl = uploadData.url;
      }

      const response = await authFetch('/api/human/proofs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: proofTitle,
          ecosystem: proofEcosystem,
          contributionType: proofType,
          description: proofDescription,
          externalLinks: proofLinks.split(',').map((link) => link.trim()).filter(Boolean),
          fileUrl,
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Proof submission failed');

      const [storedProofs] = await Promise.all([
        fetchProofsByWallet(address),
        refetchProofs(),
      ]);
      setProofs(storedProofs);
      setShowAddProof(false);
      setProofTitle(''); setProofEcosystem(''); setProofDescription(''); setProofLinks('');
      setProofFile(null); setProofFilePreview(null);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Proof submission failed');
    } finally {
      setProofUploading(false);
    }
  };

  const [pFile, setPFile] = useState<File | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  const handlePortfolioImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setErrorMsg('Image must be under 20MB'); return; }
    setPFile(file);
    // Preview
    const reader = new FileReader();
    reader.onload = () => setPImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmitPortfolio = async () => {
    if (!address || !pTitle) return;
    setUploadingFile(true);
    let imageUrl: string | undefined;

    // Upload file to backend if present
    if (pFile) {
      try {
        const formData = new FormData();
        formData.append('file', pFile);
        const res = await authFetch('/api/upload/portfolio', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) imageUrl = data.url;
      } catch (err) {
        console.error('Upload failed:', err);
      }
    }

    const item: PortfolioItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      wallet: address, title: pTitle, description: pDescription, category: pCategory,
      imageDataURI: imageUrl || undefined, externalLink: pLink || undefined,
      githubRepo: pGithub.trim() || undefined,
      tags: pTags.split(',').map(t => t.trim()).filter(Boolean),
      createdAt: new Date().toISOString(), order: portfolio.length,
    };
    savePortfolioItem(authFetch, item);
    setTimeout(() => fetchPortfolioByWallet(address).then(setPortfolio), 300);
    setShowAddPortfolio(false);
    setUploadingFile(false);
    setPTitle(''); setPDescription(''); setPLink(''); setPGithub(''); setPTags(''); setPFile(null); setPImagePreview(null);
  };

  const handleDeletePortfolio = (id: string) => {
    if (!address) return;
    // Find item to delete file from backend
    const item = portfolio.find(p => p.id === id);
    if (item?.imageDataURI?.startsWith('http')) {
      const filename = item.imageDataURI.split('/').pop();
      if (filename) {
        authFetch(`/api/files/portfolio/${filename}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    deletePortfolioItem(authFetch, id);
    setTimeout(() => fetchPortfolioByWallet(address).then(setPortfolio), 300);
  };

  // ── Not connected (or Agent entry) ──
  if (status === 'connecting') {
    return <div className="min-h-[80vh]" />;
  }

  if (!isConnected) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-6">
        <div className="max-w-lg w-full animate-fade-in">
          {/* Logo accent */}
          <div className="text-center mb-10">
            <div className="relative w-20 h-20 mx-auto mb-8">
              <div className="absolute inset-0 border border-[rgba(255,133,18,0.3)] rotate-45" />
              <div className="absolute inset-2 border border-[rgba(255,133,18,0.15)] rotate-45" />
              <div className="absolute inset-0 flex items-center justify-center">
                <BardLogo size={32} className="text-[#ff8512]" />
              </div>
            </div>
            <h1 className="text-3xl font-bold text-white mb-3">Join BARD</h1>
            <p className="text-surface-400 text-sm max-w-xs mx-auto leading-relaxed">
              Build your reputation with a BARD-managed wallet on Arc.
            </p>
          </div>

          {/* Entry — Human only (agents use MCP) */}
          <div className="mb-6">
            <div className="p-5 text-left border border-[rgba(255,133,18,0.4)] bg-[rgba(255,133,18,0.06)]">
              <div className="font-mono text-sm font-bold text-white mb-1">Human Profile</div>
              <div className="font-mono text-[10px] text-surface-500">Continue with email or an existing login wallet</div>
            </div>
          </div>

          {/* Privy login */}
          <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-8 animate-fade-in">
            <button
              onClick={login}
              className="btn-primary w-full text-xs py-3.5"
            >
              Continue with email or wallet
            </button>
          </div>

          {/* Agent note */}
          <div className="mt-6 border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-xs text-purple-400">⬡</span>
              <span className="font-mono text-xs text-surface-400 uppercase tracking-wider">AI Agents?</span>
            </div>
            <p className="font-mono text-[10px] text-surface-500 leading-relaxed">
              Agents register via MCP — no wallet needed. After creating your human profile, you can link your agent to it.
              See the <a href="/agents" className="text-[#ff8512] hover:underline">Agents page</a> for setup instructions.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Existing profile — unified profile + dashboard ──
  if (existingProfile && step !== 3) {

    const handleEditPfpUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { setSaveMsg('Image must be under 5MB'); return; }
      const reader = new FileReader();
      reader.onload = () => setEditPfpPreview(reader.result as string);
      reader.readAsDataURL(file);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await authFetch('/api/upload/pfp', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) setEditPfpUrl(data.url);
        else setSaveMsg('Upload failed');
      } catch { setSaveMsg('Could not upload image'); }
    };

    const handleSaveSettings = async () => {
      setSaving(true); setSaveMsg('');
      try {
        const response = await authFetch('/api/human/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: existingProfile.username,
            displayName: editDisplayName,
            bio: editBio,
            profileType: existingProfile.profileType,
            ecosystems: editEcosystems.split(',').map((item) => item.trim()).filter(Boolean),
            farcaster: editFarcaster,
            github: editGithub,
            x: editX,
            discord: editDiscord,
            linkedin: editLinkedin,
            pfp: editPfpUrl,
          }),
        });
        const data = await response.json() as { profile?: StoredProfile; error?: string };
        if (!response.ok || !data.profile) {
          throw new Error(data.error || 'Profile update failed');
        }
        setExistingProfile(data.profile);
        setSaveMsg('Settings saved');
        setTimeout(() => setSaveMsg(''), 3000);
      } catch (error) {
        setSaveMsg(error instanceof Error ? error.message : 'Profile update failed');
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="max-w-4xl mx-auto px-6 py-16">
        {/* Profile card */}
        <div className="relative border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-8 animate-fade-in mb-10">
          {/* Settings gear icon - top right */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`absolute top-4 right-4 w-9 h-9 flex items-center justify-center border transition-all hover:border-[rgba(255,133,18,0.3)] hover:text-[#ff8512] ${
              showSettings ? 'border-[#ff8512] text-[#ff8512] bg-[rgba(255,133,18,0.05)]' : 'border-[rgba(255,255,255,0.06)] text-surface-500'
            }`}
            title="Profile Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>
          <div className="flex items-start gap-6 mb-8">
            {existingProfile.pfp ? (
              <div className="w-14 h-14 border border-[rgba(255,133,18,0.2)] shrink-0 overflow-hidden">
                <img src={existingProfile.pfp} alt="PFP" className="w-full h-full object-cover" />
              </div>
            ) : existingPFP && typeof existingPFP === 'string' && existingPFP.length > 0 ? (
              <div className="w-14 h-14 border border-[rgba(255,133,18,0.2)] shrink-0 overflow-hidden">
                <img src={existingPFP} alt="PFP" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="w-14 h-14 bg-[#141414] border border-[rgba(255,133,18,0.2)] flex items-center justify-center text-xl font-bold text-[#ff8512] font-mono shrink-0">
                {existingProfile.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <h1 className="text-xl font-bold text-white">{existingProfile.displayName}</h1>
                <span className={existingProfile.profileType === 'human' ? 'badge-human' : 'badge-agent'}>{existingProfile.profileType}</span>
                {onChainExists && <span className="font-mono text-[10px] text-emerald-500 tracking-wider">ON-CHAIN</span>}
              </div>
              <div className="font-mono text-sm text-[#ff8512] mb-3">@{existingProfile.username}</div>
              <p className="text-sm text-surface-400 leading-relaxed">{existingProfile.bio}</p>
            </div>
          </div>

          {existingProfile.ecosystems.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-8">
              {existingProfile.ecosystems.map((eco) => (
                <span key={eco} className="px-3 py-1 border border-[rgba(255,255,255,0.06)] font-mono text-xs text-surface-300">{eco}</span>
              ))}
            </div>
          )}

          <div className="space-y-px bg-[rgba(255,255,255,0.06)] mb-8">
            {[
              { label: 'Wallet', value: `${address?.slice(0, 6)}...${address?.slice(-4)}`, mono: true },
              { label: 'Network', value: 'Arc Testnet' },
              { label: 'Profile', value: onChainExists ? 'On-chain' : 'Local only' },
              { label: 'Identity', value: identityRegistered ? 'ERC-8004 (via Agent)' : 'Agent-minted' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between p-3 bg-[#050505] text-sm">
                <span className="text-surface-500 font-mono text-xs uppercase tracking-wider">{row.label}</span>
                <span className={`${row.mono ? 'font-mono' : ''} text-surface-200 text-xs`}>{row.value}</span>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <Link href={`/u/${existingProfile.username}`} className="btn-primary flex-1 text-center text-xs">View Public Profile</Link>
            <button onClick={() => setShowAddProof(true)} className="btn-secondary flex-1 text-xs">+ Add Proof</button>
          </div>

          {/* ─── Settings Panel ─── */}
          {showSettings && (
            <div className="mt-6 border border-[rgba(255,133,18,0.15)] bg-[rgba(255,133,18,0.02)] p-6 animate-fade-in">
              <div className="flex items-center gap-3 mb-6">
                <div className="accent-line" />
                <span className="font-mono text-[10px] text-surface-500 tracking-[0.15em] uppercase">Profile Settings</span>
              </div>

              {/* PFP Upload */}
              <div className="mb-6">
                <span className="label-mono block mb-3">Profile Picture</span>
                <div className="flex items-center gap-4">
                  {editPfpPreview ? (
                    <div className="w-20 h-20 border border-[rgba(255,133,18,0.2)] shrink-0 overflow-hidden">
                      <img src={editPfpPreview} alt="PFP" className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="w-20 h-20 bg-[#141414] border border-[rgba(255,133,18,0.2)] flex items-center justify-center text-2xl font-bold text-[#ff8512] font-mono shrink-0">
                      {editDisplayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <label className="btn-secondary text-xs cursor-pointer inline-block px-4 py-2">
                      Change Image
                      <input type="file" accept="image/*" onChange={handleEditPfpUpload} className="hidden" />
                    </label>
                    <p className="font-mono text-[9px] text-surface-600 mt-1">PNG, JPG, WebP, GIF -- Max 5MB</p>
                  </div>
                </div>
              </div>

              {/* Display Name */}
              <div className="mb-5">
                <span className="label-mono block mb-2">Display Name</span>
                <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} className="input-field" />
              </div>

              {/* Username (locked) */}
              <div className="mb-5">
                <span className="label-mono block mb-2">Username (locked)</span>
                <div className="input-field bg-[#080808] text-surface-600 cursor-not-allowed">@{existingProfile.username}</div>
              </div>

              {/* Bio */}
              <div className="mb-5">
                <span className="label-mono block mb-2">Bio</span>
                <textarea value={editBio} onChange={(e) => setEditBio(e.target.value)} className="input-field" rows={3} />
              </div>

              {/* Ecosystems */}
              <div className="mb-5">
                <span className="label-mono block mb-2">Ecosystems (comma-separated)</span>
                <input value={editEcosystems} onChange={(e) => setEditEcosystems(e.target.value)} className="input-field" placeholder="arc, base, ritual" />
              </div>

              {/* Social Links */}
              <div className="grid grid-cols-2 gap-4 mb-5">
                <div>
                  <span className="label-mono block mb-2">Farcaster</span>
                  <input value={editFarcaster} onChange={(e) => setEditFarcaster(e.target.value)} className="input-field" placeholder="username.eth" />
                </div>
                <div>
                  <span className="label-mono block mb-2">GitHub</span>
                  <input value={editGithub} onChange={(e) => setEditGithub(e.target.value)} className="input-field" placeholder="username" />
                </div>
                <div>
                  <span className="label-mono block mb-2">X (Twitter)</span>
                  <input value={editX} onChange={(e) => setEditX(e.target.value)} className="input-field" placeholder="@handle" />
                </div>
                <div>
                  <span className="label-mono block mb-2">Discord</span>
                  <input value={editDiscord} onChange={(e) => setEditDiscord(e.target.value)} className="input-field" placeholder="username#0000" />
                </div>
                <div>
                  <span className="label-mono block mb-2">LinkedIn</span>
                  <input value={editLinkedin} onChange={(e) => setEditLinkedin(e.target.value)} className="input-field" placeholder="in/username" />
                </div>
              </div>

              {/* Save */}
              <div className="flex items-center gap-3">
                <button onClick={handleSaveSettings} disabled={saving} className="btn-primary text-xs px-8">
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                {saveMsg && (
                  <span className={`font-mono text-xs ${saveMsg === 'Settings saved' ? 'text-emerald-400' : 'text-red-400'}`}>{saveMsg}</span>
                )}
              </div>
            </div>
          )}

          {/* Linked Agent Status + Link Form */}
          <LinkedAgentStatus ownerWallet={address || ''} />

          <div className="border border-[rgba(168,85,247,0.2)] bg-[rgba(168,85,247,0.03)] p-5 mt-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-xs text-purple-400">⬡</span>
              <span className="font-mono text-[10px] text-white tracking-wider uppercase">Link an Agent</span>
            </div>
            <p className="font-mono text-[10px] text-surface-500 mb-4 leading-relaxed">
              Your agent generates a link token via <span className="text-surface-400">bard link-token</span> or <span className="text-surface-400">bard_generate_link_token</span> MCP tool.
              Paste it below to verify ownership and connect the agent to your profile.
            </p>
            <LinkAgentForm ownerWallet={address || ''} />
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[rgba(255,255,255,0.06)] mb-10">
          {[
            { label: 'SCORE', value: '—' },
            { label: 'PROOFS', value: String((Array.isArray(onChainProofs) ? onChainProofs.length : 0) + proofs.length) },
            { label: 'VOUCHES', value: String(myVouchCount) },
            { label: 'USDC STAKED', value: myTotalStaked > 0 ? myTotalStaked.toFixed(2) : '0' },
          ].map((s) => (
            <div key={s.label} className="bg-[#050505] p-5 text-center">
              <div className="text-xl font-bold text-white font-mono">{s.value}</div>
              <div className="font-mono text-[10px] text-surface-500 tracking-[0.15em] mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-px bg-[rgba(255,255,255,0.06)] w-fit mb-8">
          {(['portfolio', 'proofs', 'vouches'] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-6 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                activeTab === tab ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#050505] text-surface-400 hover:text-white'
              }`}>
              {tab}
            </button>
          ))}
        </div>

        {/* Portfolio */}
        {activeTab === 'portfolio' && (
          <div className="animate-fade-in">
            {portfolio.length === 0 ? (
              <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-14 text-center">
                <div className="font-mono text-surface-500 text-sm mb-4">Your portfolio is empty</div>
                <p className="text-xs text-surface-400 max-w-md mx-auto mb-6">
                  Showcase your work — designs, code, art, and contributions.
                </p>
                <button onClick={() => setShowAddPortfolio(true)} className="btn-primary text-xs">+ Add First Work</button>
              </div>
            ) : (
              <>
                <div className="flex justify-end mb-4">
                  <button onClick={() => setShowAddPortfolio(true)} className="btn-primary text-xs px-4 py-2">+ Add Work</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {portfolio.map((item) => (
                    <div key={item.id}
                      className="group relative bg-[#0a0a0a] border border-[rgba(255,255,255,0.06)] overflow-hidden cursor-pointer hover:border-[rgba(255,133,18,0.3)] transition-all duration-300"
                      onClick={() => setExpandedItem(item)}>
                      {/* Image */}
                      <div className="aspect-[4/3] bg-[#111] overflow-hidden">
                        {item.imageDataURI ? (
                          <img src={item.imageDataURI} alt={item.title}
                            className="w-full h-full object-cover opacity-70 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <span className="font-mono text-3xl text-surface-600 group-hover:text-[#ff8512] transition-colors">{item.category[0].toUpperCase()}</span>
                          </div>
                        )}
                      </div>
                      {/* Info */}
                      <div className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <h3 className="text-sm font-medium text-white group-hover:text-[#ff8512] transition-colors truncate flex-1 pr-2">{item.title}</h3>
                          <span className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-[9px] text-surface-500 uppercase shrink-0">{item.category}</span>
                        </div>
                        {item.description && <p className="text-xs text-surface-400 line-clamp-2 mb-3">{item.description}</p>}
                        {item.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {item.tags.slice(0, 3).map(tag => (
                              <span key={tag} className="px-1.5 py-0.5 bg-[rgba(255,255,255,0.03)] font-mono text-[9px] text-surface-500">{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      {/* Delete button */}
                      <button onClick={(e) => { e.stopPropagation(); handleDeletePortfolio(item.id); }}
                        className="absolute top-2 right-2 w-6 h-6 bg-black/60 text-surface-500 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Expanded Portfolio Item */}
        {expandedItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setExpandedItem(null)}>
            <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />
            <div className="relative z-10 max-w-2xl w-full bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] animate-slide-up" onClick={(e) => e.stopPropagation()}>
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
                      GitHub Repo →
                    </a>
                  )}
                  {expandedItem.externalLink && (
                    <a href={expandedItem.externalLink} target="_blank" rel="noopener noreferrer" className="btn-primary text-xs px-5 py-2">
                      {expandedItem.category === 'code' ? 'View Demo →' : 'View Project →'}
                    </a>
                  )}
                  <button onClick={() => setExpandedItem(null)} className="btn-secondary text-xs px-5 py-2">Close</button>
                  <span className="text-[10px] text-surface-600 font-mono ml-auto">{new Date(expandedItem.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Proofs */}
        {activeTab === 'proofs' && (
          <div className="animate-fade-in">
            {(!Array.isArray(onChainProofs) || onChainProofs.length === 0) && proofs.length === 0 ? (
              <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-14 text-center">
                <div className="font-mono text-surface-500 text-sm mb-4">No proofs submitted</div>
                <p className="text-xs text-surface-400 max-w-md mx-auto mb-6">
                  Add your first proof of work to build reputation.
                </p>
                <button onClick={() => setShowAddProof(true)} className="btn-primary text-xs">+ Add First Proof</button>
              </div>
            ) : (
              <div className="space-y-px bg-[rgba(255,255,255,0.06)]">
                {Array.isArray(onChainProofs) && onChainProofs.map((proof, i) => (
                  <div key={`chain-${i}`} className="bg-[#050505] p-5">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="text-sm font-medium text-white flex-1 pr-4">{proof.title}</h3>
                      <div className="flex gap-2 shrink-0">
                        <span className="text-[10px] px-2 py-0.5 bg-emerald-900/30 border border-emerald-800/30 text-emerald-400 font-mono">VERIFIED</span>
                        <span className="text-xs px-2 py-0.5 status-unvalidated font-mono">
                          {Number(proof.status) === 1 ? 'validated' : Number(proof.status) === 2 ? 'disputed' : 'unvalidated'}
                        </span>
                      </div>
                    </div>
                    {proof.description && <p className="text-xs text-surface-400 mb-3">{proof.description}</p>}
                    <div className="flex items-center gap-3 text-xs">
                      <span className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-surface-400">{proof.ecosystem}</span>
                      <span className="text-surface-500">{proof.contributionType}</span>
                      <span className="text-surface-600 font-mono">{new Date(Number(proof.timestamp) * 1000).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
                {proofs.map((proof) => (
                  <div key={proof.id} className="bg-[#050505] p-5">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="text-sm font-medium text-white flex-1 pr-4">{proof.title}</h3>
                      <span className="text-xs px-2 py-0.5 shrink-0 status-unvalidated font-mono">{proof.status}</span>
                    </div>
                    {proof.description && <p className="text-xs text-surface-400 mb-3">{proof.description}</p>}
                    <div className="flex items-center gap-3 text-xs">
                      <span className="px-2 py-0.5 border border-[rgba(255,255,255,0.06)] font-mono text-surface-400">{proof.ecosystem}</span>
                      <span className="text-surface-500">{proof.contributionType}</span>
                      <span className="text-surface-600 font-mono">{new Date(proof.timestamp).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Vouches */}
        {activeTab === 'vouches' && (
          <div className="animate-fade-in">
            <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-14 text-center">
              <div className="font-mono text-surface-500 text-sm mb-4">No vouches received</div>
              <p className="text-xs text-surface-400 max-w-md mx-auto">
                Share your profile to get vouched by ecosystem contributors.
              </p>
            </div>
          </div>
        )}

        {/* Add Proof Modal */}
        {showAddProof && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/70" onClick={() => setShowAddProof(false)} />
            <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] p-8 w-full max-w-lg relative z-10 animate-slide-up max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold text-white mb-6">Add Proof of Work</h2>
              <div className="space-y-5">
                <div>
                  <span className="label-mono block mb-2">Title</span>
                  <input value={proofTitle} onChange={(e) => setProofTitle(e.target.value)} placeholder="What did you contribute?" className="input-field" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="label-mono block mb-2">Ecosystem</span>
                    <input value={proofEcosystem} onChange={(e) => setProofEcosystem(e.target.value)} placeholder="Arc, Monad..." className="input-field" />
                  </div>
                  <div>
                    <span className="label-mono block mb-2">Type</span>
                    <select value={proofType} onChange={(e) => setProofType(e.target.value)} className="input-field">
                      {CONTRIBUTION_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
                    </select>
                  </div>
                </div>
                <div>
                  <span className="label-mono block mb-2">Description</span>
                  <textarea value={proofDescription} onChange={(e) => setProofDescription(e.target.value)} placeholder="Describe your contribution..." className="input-field" rows={3} />
                </div>

                {/* File Upload */}
                <div>
                  <span className="label-mono block mb-2">Evidence <span className="text-surface-600">(screenshot, video, document — max 20MB)</span></span>
                  <div className="border border-dashed border-[rgba(255,255,255,0.1)] bg-[#050505] p-4 text-center">
                    {proofFilePreview ? (
                      <div className="relative">
                        {proofFile?.type.startsWith('video/') ? (
                          <video src={proofFilePreview} className="max-h-40 mx-auto mb-2" muted autoPlay loop />
                        ) : (
                          <img src={proofFilePreview} alt="Preview" className="max-h-40 mx-auto object-contain mb-2" />
                        )}
                        <div className="text-[10px] text-surface-500 font-mono mb-1">{proofFile?.name} ({proofFile ? (proofFile.size / 1024).toFixed(0) : 0}KB)</div>
                        <button onClick={() => { setProofFile(null); setProofFilePreview(null); }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                      </div>
                    ) : (
                      <label className="cursor-pointer">
                        <div className="text-surface-500 text-sm mb-1">Click to upload proof</div>
                        <div className="text-surface-600 text-[10px] font-mono">Images up to 20MB · Videos up to 25MB</div>
                        <div className="text-yellow-500/70 text-[9px] font-mono mt-1">Max 3 videos per account -- oldest video auto-removed when limit reached</div>
                        <input type="file" accept="image/*,video/*" onChange={handleProofFileChange} className="hidden" />
                      </label>
                    )}
                  </div>
                </div>

                <div>
                  <span className="label-mono block mb-2">Links <span className="text-surface-600">(comma-separated)</span></span>
                  <input value={proofLinks} onChange={(e) => setProofLinks(e.target.value)} placeholder="https://..." className="input-field font-mono" />
                </div>
                {errorMsg && (
                  <div className="p-3 bg-red-900/20 border border-red-900/30 text-red-400 text-sm font-mono">
                    {errorMsg}
                  </div>
                )}
              </div>
              <div className="flex gap-3 mt-8">
                <button onClick={() => { setShowAddProof(false); setProofFile(null); setProofFilePreview(null); }} className="btn-secondary flex-1 text-xs">Cancel</button>
                <button onClick={handleSubmitProof} disabled={!proofTitle || !proofEcosystem || proofUploading} className="btn-primary flex-1 text-xs">
                  {proofUploading ? 'Uploading...' : 'Save Proof'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Portfolio Modal */}
        {showAddPortfolio && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/70" onClick={() => setShowAddPortfolio(false)} />
            <div className="bg-[#0c0c0c] border border-[rgba(255,255,255,0.06)] p-8 w-full max-w-lg relative z-10 animate-slide-up max-h-[90vh] overflow-y-auto">
              <h3 className="font-mono text-lg text-white mb-6">Add Work</h3>
              <div className="space-y-4">
                <div>
                  <span className="label-mono block mb-2">Title *</span>
                  <input type="text" value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="Project name" className="input-field" />
                </div>
                <div>
                  <span className="label-mono block mb-2">Category</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(['design', 'code', 'art', 'video', 'writing', 'other'] as const).map((cat) => (
                      <button key={cat} onClick={() => setPCategory(cat)}
                        className={`px-3 py-2 font-mono text-[10px] uppercase tracking-wider border transition-colors ${
                          pCategory === cat ? 'bg-[#ff8512] text-[#050505] border-[#ff8512]' : 'bg-[#050505] text-surface-400 border-[rgba(255,255,255,0.06)] hover:text-white'
                        }`}>
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="label-mono block mb-2">File <span className="text-surface-600">(max 20MB)</span></span>
                  <div className="border border-dashed border-[rgba(255,255,255,0.1)] bg-[#050505] p-4 text-center">
                    {pImagePreview ? (
                      <div className="relative">
                        {pFile?.type.startsWith('video/') ? (
                          <video src={pImagePreview} className="max-h-40 mx-auto mb-2" muted autoPlay loop />
                        ) : (
                          <img src={pImagePreview} alt="Preview" className="max-h-40 mx-auto object-contain mb-2" />
                        )}
                        <div className="text-[10px] text-surface-500 font-mono mb-1">{pFile?.name} ({pFile ? (pFile.size / 1024).toFixed(0) : 0}KB)</div>
                        <button onClick={() => { setPFile(null); setPImagePreview(null); }} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                      </div>
                    ) : (
                      <label className="cursor-pointer">
                        <div className="text-surface-500 text-sm mb-1">Click to upload</div>
                        <div className="text-surface-600 text-[10px] font-mono">PNG, JPG, GIF, WebP, MP4, WebM</div>
                        <input type="file" accept="image/*,video/*" onChange={handlePortfolioImage} className="hidden" />
                      </label>
                    )}
                  </div>
                </div>
                <div>
                  <span className="label-mono block mb-2">Description</span>
                  <textarea value={pDescription} onChange={(e) => setPDescription(e.target.value)} placeholder="What did you build?" className="input-field min-h-[80px]" />
                </div>
                {pCategory === 'code' && (
                  <div>
                    <span className="label-mono block mb-2">GitHub Repo</span>
                    <input
                      type="text"
                      value={pGithub}
                      onChange={(e) => setPGithub(e.target.value)}
                      placeholder="github.com/user/repo or https://github.com/user/repo"
                      className="input-field font-mono"
                    />
                  </div>
                )}
                <div>
                  <span className="label-mono block mb-2">
                    {pCategory === 'code' ? 'Demo / Live URL' : 'External Link'}
                  </span>
                  <input type="text" value={pLink} onChange={(e) => setPLink(e.target.value)} placeholder="https://..." className="input-field font-mono" />
                </div>
                <div>
                  <span className="label-mono block mb-2">Tags <span className="text-surface-600">(comma-separated)</span></span>
                  <input type="text" value={pTags} onChange={(e) => setPTags(e.target.value)} placeholder="react, solidity, figma" className="input-field" />
                </div>
                <div className="flex gap-3 pt-4">
                  <button onClick={() => { setShowAddPortfolio(false); setPFile(null); setPImagePreview(null); }} className="btn-secondary flex-1 text-xs">Cancel</button>
                  <button onClick={handleSubmitPortfolio} disabled={!pTitle || uploadingFile} className="btn-primary flex-1 text-xs">
                    {uploadingFile ? 'Uploading...' : 'Add to Portfolio'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Profile creation flow ──
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
      {/* Progress */}
      <div className="flex items-center gap-4 mb-14">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-3 flex-1">
            <div className={`w-8 h-8 flex items-center justify-center font-mono text-sm font-bold transition-all ${
              s <= step ? 'bg-[#ff8512] text-[#050505]' : 'bg-[#141414] border border-[rgba(255,255,255,0.06)] text-surface-500'
            }`}>
              {s === 3 && step === 3 ? '✓' : s}
            </div>
            <span className={`font-mono text-xs tracking-wider uppercase ${s <= step ? 'text-white' : 'text-surface-600'}`}>
              {s === 1 ? 'Identity' : s === 2 ? 'Details' : 'Done'}
            </span>
            {s < 3 && <div className={`flex-1 h-px ${s < step ? 'bg-[#ff8512]' : 'bg-[rgba(255,255,255,0.06)]'}`} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-6 sm:p-8 lg:p-10 animate-fade-in max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Choose Your Identity</h2>
          <p className="text-surface-400 text-sm mb-8">Create your identity on BARD. Agents mint ERC-8004 on your behalf.</p>

          <span className="label-mono block mb-3">Profile Type</span>
          <div className="grid grid-cols-2 gap-3 mb-8">
            {PROFILE_TYPES.map((type) => (
              <button key={type} onClick={() => setProfileType(type)}
                className={`p-4 border text-left transition-all ${
                  profileType === type ? 'border-[#ff8512] bg-[rgba(255,133,18,0.05)]' : 'border-[rgba(255,255,255,0.06)] bg-[#050505] hover:border-[rgba(255,255,255,0.12)]'
                }`}>
                <div className="font-mono text-sm font-semibold text-white capitalize mb-1">{type}</div>
                <div className="text-xs text-surface-400">
                  {type === 'human' ? 'Contributor, designer, moderator' : 'Autonomous AI agent on Arc'}
                </div>
              </button>
            ))}
          </div>

          <span className="label-mono block mb-2">Username</span>
          <div className="relative mb-2">
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="your-name" className="input-field font-mono" maxLength={32} />
          </div>
          {username && !isValidUsername(username) && <p className="text-red-400 font-mono text-xs mb-6">3-32 chars · lowercase · no double hyphens</p>}
          {username && isValidUsername(username) && usernameIsTaken && <p className="text-red-400 font-mono text-xs mb-6">✗ taken on-chain</p>}
          {username && isValidUsername(username) && usernameIsTaken === false && <p className="text-emerald-500 font-mono text-xs mb-6">✓ available</p>}

          <button onClick={() => setStep(2)} disabled={!isValidUsername(username) || usernameIsTaken === true} className="btn-primary w-full mt-4 text-xs">Continue</button>
        </div>
      )}

      {step === 2 && profileType === 'agent' && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-8 animate-fade-in">
          <h2 className="text-2xl font-bold text-white mb-2">Agent Authentication</h2>
          <p className="text-surface-400 text-sm mb-8">Agents authenticate via MCP — not wallet connect.</p>
          <AgentAuth />
          <div className="flex gap-3 pt-6">
            <button onClick={() => { setStep(1); setTxStatus('idle'); setErrorMsg(''); }} className="btn-secondary flex-1 text-xs">Back</button>
          </div>
        </div>
      )}

      {step === 2 && profileType === 'human' && (
        <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-6 sm:p-8 lg:p-10 animate-fade-in max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Profile Details</h2>
          <p className="text-surface-400 text-sm mb-8">Profile details stored on BARD. Link an agent to mint ERC-8004.</p>
          <div className="space-y-6">
            {/* PFP Upload */}
            <div className="lg:col-span-2">
              <span className="label-mono block mb-2">Profile Picture <span className="text-surface-600">(stored with your BARD profile)</span></span>
              <div className="flex items-center gap-5">
                <label className="w-20 h-20 border border-dashed border-[rgba(255,255,255,0.12)] bg-[#050505] flex items-center justify-center cursor-pointer hover:border-[#ff8512] transition-colors overflow-hidden shrink-0">
                  {pfpPreview ? (
                    <img src={pfpPreview} alt="PFP" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-surface-500 text-2xl">+</span>
                  )}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handlePfpUpload} className="hidden" />
                </label>
                <div className="text-xs text-surface-500">
                  <p>Upload up to 5MB</p>
                  <p>PNG, JPG, WebP, or GIF</p>
                  {pfpUploading && <p className="mt-1" style={{ color: 'var(--accent)' }}>Uploading…</p>}
                  {!pfpUploading && pfpDataURI && <p className="mt-1" style={{ color: 'var(--ok)' }}>Uploaded ✓ Ready to save</p>}
                  {!pfpUploading && pfpPreview && !pfpDataURI && !errorMsg && <p className="mt-1" style={{ color: 'var(--muted)' }}>Preview shown — uploading…</p>}
                  {errorMsg && errorMsg.toLowerCase().includes('image') && (
                    <p className="mt-1 max-w-[220px]" style={{ color: 'var(--danger)' }}>{errorMsg}</p>
                  )}
                </div>
              </div>
            </div>
            <div>
              <span className="label-mono block mb-2">Display Name</span>
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" className="input-field" />
            </div>
            <div className="lg:col-span-2">
              <span className="label-mono block mb-2">Bio</span>
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Tell us about yourself..." className="input-field" rows={3} />
            </div>
            <div>
              <span className="label-mono block mb-2">Ecosystems <span className="text-surface-600">(comma-separated)</span></span>
              <input type="text" value={ecosystems} onChange={(e) => setEcosystems(e.target.value)} placeholder="Arc, Monad, Base" className="input-field" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="label-mono block mb-2">Farcaster</span>
                <input type="text" value={farcaster} onChange={(e) => setFarcaster(e.target.value)} placeholder="username.eth" className="input-field font-mono" />
              </div>
              <div>
                <span className="label-mono block mb-2">GitHub</span>
                <input type="text" value={github} onChange={(e) => setGithub(e.target.value)} placeholder="username" className="input-field font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="label-mono block mb-2">X (Twitter)</span>
                <input type="text" value={xHandle} onChange={(e) => setXHandle(e.target.value)} placeholder="@handle" className="input-field font-mono" />
              </div>
              <div>
                <span className="label-mono block mb-2">Discord</span>
                <input type="text" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="username#0000" className="input-field font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="label-mono block mb-2">LinkedIn</span>
                <input type="text" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder="in/username" className="input-field font-mono" />
              </div>
            </div>
            {errorMsg && <div className="p-3 bg-red-900/20 border border-red-900/30 text-red-400 text-sm font-mono">{errorMsg}</div>}
            <div className="flex gap-3 pt-4">
              <button onClick={() => { setStep(1); setTxStatus('idle'); setErrorMsg(''); }} className="btn-secondary flex-1 text-xs">Back</button>
              <button onClick={handleSubmit} disabled={!displayName || txStatus === 'submitting'} className="btn-primary flex-1 text-xs">
                {txStatus === 'submitting' ? 'Registering...' : 'Register on Arc'}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && existingProfile && (
        <div className="animate-fade-in space-y-6">
          <div className="border border-[rgba(255,255,255,0.06)] bg-[#0c0c0c] p-8 text-center">
            <div className="w-12 h-12 bg-[#ff8512] flex items-center justify-center mx-auto mb-6 text-[#050505] font-mono font-bold text-lg">✓</div>
            <h2 className="text-2xl font-bold text-white mb-3">Profile Registered</h2>
            <p className="text-surface-400 text-sm mb-2">Profile registered on BARD. Link an agent to mint your ERC-8004 identity.</p>
            <p className="text-[#ff8512] font-mono text-lg mb-4">@{existingProfile.username}</p>
            {profileTxHash && (
              <a href={profileExplorer || `https://testnet.arcscan.app/tx/${profileTxHash}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-surface-500 hover:text-[#ff8512] underline mb-8 block">
                View transaction ↗
              </a>
            )}
            <div className="flex gap-3">
              <Link href={`/u/${existingProfile.username}`} className="btn-primary flex-1 text-xs">View Profile</Link>
              <button onClick={() => { setStep(0); setShowAddProof(true); }} className="btn-secondary flex-1 text-xs">Add Proof</button>
            </div>
          </div>

          {/* Link Agent Section */}
          <div className="border border-[rgba(168,85,247,0.2)] bg-[rgba(168,85,247,0.03)] p-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="font-mono text-xs text-purple-400">⬡</span>
              <span className="font-mono text-xs text-white tracking-wider uppercase">Link an Agent</span>
            </div>
            <p className="font-mono text-[10px] text-surface-500 mb-4 leading-relaxed">
              If you&apos;ve registered an agent via MCP, enter its Agent ID below to link it to your profile.
              This proves you own the agent.
            </p>
            <LinkAgentForm ownerWallet={existingProfile.wallet} />
          </div>
        </div>
      )}
    </div>
  );
}
