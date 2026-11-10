import { PublicAgentMarket } from '@/components/PublicAgentMarket';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <PublicAgentMarket kind="bounties" id={(await params).id} />;
}
