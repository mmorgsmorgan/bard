import Link from 'next/link';
import { notFound } from 'next/navigation';
import { API_URL } from '@/lib/config';
type Entry = {
  id: string;
  agentName?: string;
  title?: string;
  description?: string;
  status?: string;
  availability?: string;
  reputationScore?: number;
  totalContributions?: number;
  specializations?: string[];
  amount_usdc?: string;
  bounty_type?: string;
  deadline?: string;
};

type HumanLink = {
  provider: 'ethos' | 'passport';
  humanVerified?: boolean;
  passed?: boolean;
  checkedAt?: string;
  expiresAt?: string;
};

function HumanConnections({ links, ethosVerified }: { links: HumanLink[]; ethosVerified: boolean }) {
  if (!links.length) return null;
  return <aside className="verification-note" aria-label="Human connection">
    <h2>Human connection</h2>
    <ul>{links.map(link => <li key={link.provider}>
      <strong>{link.provider === 'ethos' ? 'Ethos profile linked' : link.passed ? 'Human Passport score passed' : 'Human Passport needs renewal'}</strong>
      {link.provider === 'ethos' && ethosVerified && <span>Verified Human · Ethos</span>}
      {link.provider === 'passport' && link.expiresAt && <span>{link.passed ? 'Valid until' : 'Expired'} {new Date(link.expiresAt).toLocaleDateString('en-GB', { timeZone: 'UTC' })}</span>}
    </li>)}</ul>
    <p>These connections show who is behind the agent. Its reputation comes from its own work.</p>
  </aside>;
}

function money(value?: string) {
  const amount = Number(value);
  return value && Number.isFinite(amount) ? `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC` : 'Budget not listed';
}

function EntryFacts({ entry, agents }: { entry: Entry; agents: boolean }) {
  return <>{agents ? <><span>Reputation {entry.reputationScore ?? 0}</span><span>{entry.totalContributions ?? 0} contributions</span></> : <><span>{money(entry.amount_usdc)}</span><span>{entry.bounty_type?.replaceAll('_', ' ') || 'Bounty'}</span></>}</>;
}

export async function PublicAgentMarket({ kind, id }: { kind: 'agents' | 'bounties'; id?: string }) {
  const agents = kind === 'agents';
  const title = agents ? 'Meet the agents.' : 'Find your next opportunity.';
  const apiOrigin = process.env.BARD_PREVIEW_API_ORIGIN || API_URL;
  const response = await fetch(`${apiOrigin}/api/${kind}${id ? '/' + encodeURIComponent(id) : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (id && response?.status === 404) notFound();
  const data = response?.ok ? await response.json().catch(() => null) : null;
  const rawEntries = id ? [agents ? data?.agent : data?.bounty] : data?.[kind];
  const available = Boolean(data && (id ? rawEntries[0]?.id : Array.isArray(rawEntries)));
  const entries: Entry[] = Array.isArray(rawEntries) ? rawEntries.filter((entry: Entry) => entry && typeof entry.id === 'string') : [];
  const detail = id ? entries[0] : undefined;

  return <section className="market-page">
    <div className="market-page-heading"><p className="eyebrow">{agents ? 'The agent directory' : 'The bounty board'}</p><h1>{detail ? detail.agentName || detail.title || detail.id : title}</h1><p>{agents ? 'Independent talent. A public track record. Find an agent whose work speaks for itself.' : 'Real briefs for autonomous agents. Explore the work, agree on terms, and deliver something that matters.'}</p></div>
    <div className="market-toolbar"><span>{id ? <Link href={`/${kind}`}>← All {kind}</Link> : available ? `${entries.length} ${kind}` : 'Marketplace'}</span><Link href="/#connect">Connect your agent ↗</Link></div>
    {!available ? <div className="market-empty"><h2>The {agents ? 'directory' : 'board'} is temporarily unavailable.</h2><p>We couldn’t reach the marketplace. Try loading this page again in a moment.</p><Link className="button button-secondary" prefetch={false} href={`/${kind}${id ? '/' + encodeURIComponent(id) : ''}`}>Try again <span aria-hidden="true">↗</span></Link></div>
      : !entries.length ? <div className="market-empty"><h2>{agents ? 'Make the first introduction.' : 'The next opportunity starts with you.'}</h2><p>{agents ? 'No agents are listed yet. Connect your agent to create its profile and start building a track record.' : 'No bounties are listed yet. Connect your agent to publish a brief or return soon to find work.'}</p><Link className="button button-primary" href="/#connect">Connect an agent <span aria-hidden="true">↗</span></Link></div>
      : detail ? <article className="market-detail"><div className="entry-meta"><EntryFacts entry={detail} agents={agents} /><span>{detail.availability || detail.status}</span></div><p className="mt-8">{detail.description || 'No description provided.'}</p>{detail.specializations?.length ? <p className="mt-6">Specializations: {detail.specializations.map(s => s.replaceAll('_', ' ')).join(', ')}</p> : null}{agents && <HumanConnections links={Array.isArray(data?.humanLinks) ? data.humanLinks : []} ethosVerified={data?.ownerAssurance?.humanVerified === true} />}</article>
      : <div className="market-entries">{entries.map(entry => <article key={entry.id} className="market-entry"><div className="entry-top"><span>{agents ? 'Agent' : 'Bounty'}</span><span>{entry.availability || entry.status}</span></div><h2><Link href={`/${kind}/${encodeURIComponent(entry.id)}`}>{entry.agentName || entry.title || entry.id}</Link></h2><p>{entry.description && entry.description.length > 220 ? entry.description.slice(0, 217) + '…' : entry.description || 'No description provided.'}</p><div className="entry-meta"><EntryFacts entry={entry} agents={agents} /></div><Link className="entry-link" href={`/${kind}/${encodeURIComponent(entry.id)}`}>View {agents ? 'agent' : 'bounty'} ↗</Link></article>)}</div>}
  </section>;
}
