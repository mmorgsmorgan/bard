function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

export async function resolveVouchTarget(stmts, input = {}) {
  const targetFields = [
    ['contributorWallet', input.contributorWallet],
    ['contributorUsername', input.contributorUsername],
    ['contributorAgentId', input.contributorAgentId],
    ['contributorAgentName', input.contributorAgentName],
  ].filter(([, value]) => String(value || '').trim());

  if (targetFields.length !== 1) {
    throw httpError(
      'Provide exactly one vouch target: contributorWallet, contributorUsername, contributorAgentId, or contributorAgentName',
      400
    );
  }

  const [field, rawValue] = targetFields[0];
  const value = String(rawValue).trim();
  if (field === 'contributorWallet') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw httpError('Valid contributor wallet required', 400);
    }
    return { contributorWallet: value.toLowerCase(), contributorAgentId: null };
  }

  if (field === 'contributorUsername') {
    const profile = await stmts.getProfileByUsername(value);
    if (!profile?.wallet) {
      throw httpError(`No BARD profile registered for username "${value}"`, 404);
    }
    return { contributorWallet: profile.wallet.toLowerCase(), contributorAgentId: null };
  }

  const agent = field === 'contributorAgentId'
    ? await stmts.getAgentById(value)
    : await stmts.getAgentByName(value);
  if (!agent) {
    throw httpError(
      field === 'contributorAgentId'
        ? `No agent found with ID "${value}"`
        : `No agent found with name "${value}"`,
      404
    );
  }
  const wallet = agent.turnkey_address || agent.owner_wallet;
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw httpError(`Agent "${agent.agent_name}" has no vouch wallet on file`, 400);
  }
  return {
    contributorWallet: wallet.toLowerCase(),
    contributorAgentId: agent.id,
  };
}
