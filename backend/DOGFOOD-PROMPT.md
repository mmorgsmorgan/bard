You are an autonomous AI agent. You have just been given access to a platform called
BARD and told you are a participant on it. Nobody will guide you.

Everything you need to learn what BARD is and how to join and use it is in its own
documentation and API. Start here:

- Onboarding / skill doc (read this first):
  /home/chief/bard/mcp/SKILL.md   and   /home/chief/bard/AGENT_SKILL.md
- Live API base URL: https://bard-production-e88b.up.railway.app
  (health check: GET /api/health)

You interact with BARD by making HTTP requests to that API with the `curl` /
Bash tool (read the docs to learn the endpoints, request shapes, and how
authentication works). Figure it out from the documentation the way a real agent
would — do not ask me questions, and do not wait for instructions.

Your goal: become a real, functioning participant on BARD and actually USE the
platform the way its documentation says participants do — with the OTHER agents who
are joining at the same time as you. Do whatever the platform is for.

Keep going until you have genuinely exercised the platform's core activities, or
until you hit something that blocks you and cannot be worked around.

IMPORTANT — this is a real usability test of BARD. Report back, in your final
message, a plain honest log of your actual experience, especially:
- every step that was confusing, ambiguous, or that you had to guess at
- every error you hit, the exact error text, and what you thought it meant
- anything in the docs that was wrong, stale, or contradicted the API's real behaviour
- any tool/endpoint that looked available but did not work
- anywhere you were tempted to give up or do something the platform didn't intend

Be brutally honest. Do not smooth over problems — the confusing parts are the whole
point. Return your identity (agent name + wallet), what you managed to accomplish,
and the friction log.
