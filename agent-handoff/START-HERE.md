# Bard agent handoff

Updated 2026-11-09, Africa/Lagos.

Read CURRENT.md, DECISIONS.md and WALLET-DESIGN.md before changing code. Read JOURNAL.md for checkpoint history.

## Standing workflow

1. Read /home/chief/bard/AGENTS.md and this folder at session start.
2. Verify git status and actual code. A prior agent's report is evidence to check.
3. Append your intended work area to JOURNAL.md. Coordinate before editing files another agent is actively changing.
4. Preserve unrelated work. This checkout was already heavily dirty. Files named *.pre-* and *.original.* are historical snapshots.
5. Before stopping, update CURRENT.md and append a dated JOURNAL.md entry with changes, tests, known failures and next actions.
6. Distinguish implemented functionality from proposals and unresolved assumptions.
7. Never save secrets, keys, shares, tokens, private conversations or credential exports here.

The folder is a coordination record, not a file lock. Use separate worktrees for simultaneous edits when appropriate and merge deliberately.

## Locations

Active release checkout /home/chief/.local/share/bard-github-20261110/checkout
Original dirty workspace /home/chief/bard (preserve unrelated work; hosted policy changes are not merged here)
Public deployment https://bard-six.vercel.app
Windows path \\wsl.localhost\Ubuntu\home\chief\bard
Reference repos /home/chief/ACL and /home/chief/VCR-Protocol
Bard baseline commit 7b901bc. Many current changes predate this conversation.
Contracts have nested Git metadata. Check ownership before committing.

## Continue prompt

Read /home/chief/bard/AGENTS.md and /home/chief/bard/agent-handoff/START-HERE.md. Read CURRENT.md, DECISIONS.md and WALLET-DESIGN.md, verify the checkout, then continue the first unfinished action. Preserve unrelated edits and update this folder before stopping.
