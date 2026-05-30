'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount } from 'wagmi';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const SWARM_TYPES = [
  { value: 'SequentialWorkflow', label: 'Sequential Workflow', description: 'Agents execute one after another in order' },
  { value: 'ConcurrentWorkflow', label: 'Concurrent Workflow', description: 'Agents execute in parallel simultaneously' },
  { value: 'HierarchicalSwarm', label: 'Hierarchical Swarm', description: 'Manager agent coordinates worker agents' },
  { value: 'MixtureOfAgents', label: 'Mixture of Agents', description: 'Multiple agents vote on the best output' },
];

const MODELS = ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo', 'claude-3-opus', 'claude-3-sonnet'];

export default function SwarmSetupPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [step, setStep] = useState(1);
  const [ownership, setOwnership] = useState<'platform' | 'byok' | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyValid, setApiKeyValid] = useState<boolean | null>(null);
  const [validating, setValidating] = useState(false);
  const [swarmType, setSwarmType] = useState('SequentialWorkflow');
  const [swarmName, setSwarmName] = useState('');
  const [swarmDescription, setSwarmDescription] = useState('');
  const [agents, setAgents] = useState([
    { role: 'agent1', system_prompt: '', model: 'gpt-4o' }
  ]);
  const [registering, setRegistering] = useState(false);

  const validateApiKey = async () => {
    setValidating(true);
    try {
      const res = await fetch(`${API_BASE}/api/swarms/validate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey })
      });
      const data = await res.json();
      setApiKeyValid(data.valid);
    } catch (err) {
      setApiKeyValid(false);
    } finally {
      setValidating(false);
    }
  };

  const addAgent = () => {
    setAgents([...agents, { role: `agent${agents.length + 1}`, system_prompt: '', model: 'gpt-4o' }]);
  };

  const removeAgent = (index: number) => {
    setAgents(agents.filter((_, i) => i !== index));
  };

  const updateAgent = (index: number, field: string, value: string) => {
    const updated = [...agents];
    updated[index] = { ...updated[index], [field]: value };
    setAgents(updated);
  };

  const registerSwarm = async () => {
    if (!address) {
      alert('Connect your wallet first');
      return;
    }

    setRegistering(true);
    try {
      const swarmConfig: Record<string, unknown> = {
        swarm_type: swarmType,
        agents,
      };

      // BYOK: send plaintext key; backend encrypts before storage
      if (ownership === 'byok' && apiKey) {
        swarmConfig.user_swarms_api_key = apiKey;
      }

      const res = await fetch(`${API_BASE}/api/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerWallet: address,
          agentName: swarmName,
          agentPublicKey: address,
          agentType: 'swarm',
          description: swarmDescription,
          swarmConfig: JSON.stringify(swarmConfig)
        })
      });

      const data = await res.json();
      if (res.ok) {
        alert(`Swarm registered! Agent ID: ${data.agent.id}`);
        router.push('/agents');
      } else {
        alert(`Registration failed: ${data.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Error: ${message}`);
    } finally {
      setRegistering(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-surface-950 via-surface-900 to-surface-950 text-surface-50 p-8 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">Create Swarm Agent</h1>
          <p className="text-surface-400 mb-8">Connect your wallet to register a swarm.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-surface-950 via-surface-900 to-surface-950 text-surface-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold mb-2">Create Swarm Agent</h1>
        <p className="text-surface-400 mb-8">Set up a multi-agent swarm on BARD</p>

        {/* Progress indicator */}
        <div className="flex items-center justify-between mb-12">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                step >= s ? 'bg-primary-500 text-white' : 'bg-surface-800 text-surface-500'
              }`}>
                {s}
              </div>
              {s < 4 && <div className={`w-24 h-1 ${step > s ? 'bg-primary-500' : 'bg-surface-800'}`} />}
            </div>
          ))}
        </div>

        {/* Step 1: Choose ownership */}
        {step === 1 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold mb-4">Choose Ownership Model</h2>
            <div className="grid grid-cols-2 gap-6">
              <button
                onClick={() => { setOwnership('platform'); setStep(3); }}
                className="p-6 border-2 border-surface-700 rounded-lg hover:border-primary-500 transition text-left"
              >
                <div className="text-xl font-bold mb-2">Platform Swarm Template</div>
                <p className="text-surface-400 text-sm">Use a pre-configured swarm. Platform charges a markup.</p>
              </button>
              <button
                onClick={() => { setOwnership('byok'); setStep(2); }}
                className="p-6 border-2 border-surface-700 rounded-lg hover:border-primary-500 transition text-left"
              >
                <div className="text-xl font-bold mb-2">Custom BYOK Swarm</div>
                <p className="text-surface-400 text-sm">Bring your own Swarms API key. No platform fees.</p>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: API Key validation (BYOK only) */}
        {step === 2 && ownership === 'byok' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold mb-4">Enter Swarms API Key</h2>
            <div>
              <label className="block text-sm font-medium mb-2">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full px-4 py-2 bg-surface-800 border border-surface-700 rounded-lg"
                placeholder="sk-..."
              />
            </div>
            <button
              onClick={validateApiKey}
              disabled={!apiKey || validating}
              className="px-6 py-2 bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50"
            >
              {validating ? 'Validating...' : 'Validate Key'}
            </button>
            {apiKeyValid === true && (
              <div className="text-green-400">✓ API key is valid</div>
            )}
            {apiKeyValid === false && (
              <div className="text-red-400">✗ API key is invalid</div>
            )}
            {apiKeyValid === true && (
              <button
                onClick={() => setStep(3)}
                className="px-6 py-2 bg-primary-500 rounded-lg hover:bg-primary-600"
              >
                Continue
              </button>
            )}
          </div>
        )}

        {/* Step 3: Configure swarm */}
        {step === 3 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold mb-4">Configure Swarm</h2>

            <div>
              <label className="block text-sm font-medium mb-2">Swarm Name</label>
              <input
                type="text"
                value={swarmName}
                onChange={(e) => setSwarmName(e.target.value)}
                className="w-full px-4 py-2 bg-surface-800 border border-surface-700 rounded-lg"
                placeholder="My Research Swarm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Description</label>
              <textarea
                value={swarmDescription}
                onChange={(e) => setSwarmDescription(e.target.value)}
                className="w-full px-4 py-2 bg-surface-800 border border-surface-700 rounded-lg"
                rows={3}
                placeholder="Describe what this swarm does..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Swarm Type</label>
              <select
                value={swarmType}
                onChange={(e) => setSwarmType(e.target.value)}
                className="w-full px-4 py-2 bg-surface-800 border border-surface-700 rounded-lg"
              >
                {SWARM_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <p className="text-sm text-surface-400 mt-1">
                {SWARM_TYPES.find(t => t.value === swarmType)?.description}
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-4">
                <label className="block text-sm font-medium">Agents</label>
                <button
                  onClick={addAgent}
                  className="px-4 py-1 bg-surface-700 rounded hover:bg-surface-600 text-sm"
                >
                  + Add Agent
                </button>
              </div>

              {agents.map((agent, i) => (
                <div key={i} className="p-4 bg-surface-800 rounded-lg mb-4">
                  <div className="flex items-center justify-between mb-3">
                    <input
                      type="text"
                      value={agent.role}
                      onChange={(e) => updateAgent(i, 'role', e.target.value)}
                      className="px-3 py-1 bg-surface-700 border border-surface-600 rounded"
                      placeholder="Role"
                    />
                    {agents.length > 1 && (
                      <button
                        onClick={() => removeAgent(i)}
                        className="text-red-400 hover:text-red-300 text-sm"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <textarea
                    value={agent.system_prompt}
                    onChange={(e) => updateAgent(i, 'system_prompt', e.target.value)}
                    className="w-full px-3 py-2 bg-surface-700 border border-surface-600 rounded mb-2"
                    rows={3}
                    placeholder="System prompt for this agent..."
                  />
                  <select
                    value={agent.model}
                    onChange={(e) => updateAgent(i, 'model', e.target.value)}
                    className="w-full px-3 py-2 bg-surface-700 border border-surface-600 rounded"
                  >
                    {MODELS.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <button
              onClick={() => setStep(4)}
              disabled={!swarmName || agents.some(a => !a.system_prompt)}
              className="px-6 py-2 bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50"
            >
              Review & Register
            </button>
          </div>
        )}

        {/* Step 4: Review & Register */}
        {step === 4 && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold mb-4">Review Configuration</h2>

            <div className="p-6 bg-surface-800 rounded-lg space-y-4">
              <div>
                <div className="text-sm text-surface-400">Name</div>
                <div className="font-medium">{swarmName}</div>
              </div>
              <div>
                <div className="text-sm text-surface-400">Type</div>
                <div className="font-medium">{swarmType}</div>
              </div>
              <div>
                <div className="text-sm text-surface-400">Ownership</div>
                <div className="font-medium">{ownership === 'platform' ? 'Platform Template' : 'Custom BYOK'}</div>
              </div>
              <div>
                <div className="text-sm text-surface-400">Agents</div>
                <div className="font-medium">{agents.length} agents configured</div>
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setStep(3)}
                className="px-6 py-2 bg-surface-700 rounded-lg hover:bg-surface-600"
              >
                Back
              </button>
              <button
                onClick={registerSwarm}
                disabled={registering}
                className="px-6 py-2 bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50"
              >
                {registering ? 'Registering...' : 'Register Swarm'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
