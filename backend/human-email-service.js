const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function configured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendHumanSecurityCode({ to, code }) {
  if (!configured()) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(
        new Error('Security-code email delivery is not configured'),
        { status: 503 }
      );
    }
    return { delivered: false, provider: 'development' };
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'bard-security/1.0',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject: 'Your BARD security code',
      text: [
        `Your BARD security code is ${code}.`,
        '',
        'It expires in 10 minutes and can be used once.',
        'Never share this code. It unlocks access to export your managed wallet private key.',
      ].join('\n'),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[human-email] provider rejected security-code delivery:', response.status);
    throw Object.assign(
      new Error(data.message || `Email provider returned ${response.status}`),
      { status: 502 }
    );
  }

  return { delivered: true, provider: 'resend', providerRef: data.id || null };
}
