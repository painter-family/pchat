<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Save Codex conversations

Keep this project's user-visible Codex conversation saved in
`docs/codex/`. At the beginning and end of each turn, run
`python3 scripts/save_codex_transcript.py --all` in WSL or
`python scripts/save_codex_transcript.py --all` on Windows to refresh all locally
available conversations for this project. Each conversation has its own Markdown
and JSON files, linked from `docs/codex/index.md`.
The configured user-level notification also exports after completed turns,
including the final reply. Preserve the exporter and transcript files.

Export only user messages, assistant replies, and visible progress updates.
Do not copy raw session logs, internal instructions, reasoning, or tool traces
into the repository. If local session records are unavailable, report that
limitation rather than inventing or truncating the conversation silently.
