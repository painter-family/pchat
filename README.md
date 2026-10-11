# pchat

Personal chat service built with Next.js, TypeScript, and Tailwind CSS.
The app supports Google sign-in, private two-person conversations, shareable
invitations, and persistent messages with image/video attachments. Auth.js uses
an encrypted JWT session cookie. Chat history is stored in SQLite and media is
stored on disk. Auth.js v5 is currently a prerelease; resolved dependency versions are recorded
in `package-lock.json`.

## Local development

Use Node.js 22.13 or later (Node.js 24 LTS recommended) and npm. Chat storage
uses the built-in `node:sqlite` module; older Node versions cannot run it.
From `D:\ppain\repos\painterfamily\pchat` in a Windows terminal:

```sh
npm ci
npm run dev
```

Open http://localhost:3000. In WSL, use a Linux Node installation or run
these npm commands with the Windows Node tooling available on your PATH.

Stop the dev server with Ctrl+C before running `npm ci` again. It replaces
`node_modules`, and Windows cannot remove native modules such as Lightning CSS
while a running Node process has them loaded. If Ctrl+C leaves a worker running,
stop that project's remaining Node processes before retrying the install.

## Checks

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

Use `npm run test:watch` to rerun component tests as files change.
Use `npm start` after a successful build to run the production server.
Stop the development server before building in the same checkout.

## Project structure

- `src/app/page.tsx`: landing page.
- `src/app/layout.tsx`: root layout and page metadata.
- `src/app/globals.css`: global styles and Tailwind theme.
- `src/auth.ts`: Google provider and session configuration.
- `src/app/api/auth/[...nextauth]/route.ts`: OAuth callback and session endpoints.
- `src/components/account-panel.tsx`: reads the account from the server session.
- `src/components/account-card.tsx`: sign-in, account details, and sign-out.
- `src/app/auth/actions.ts`: server actions for sign-in and sign-out.
- `src/app/auth/error/page.tsx`: sign-in failure page.
- `.env.example`: credential template.
- `src/**/*.test.tsx` and `src/**/*.test.ts`: component and configuration tests.
- `vitest.config.mts`: component test configuration.

## Google sign-in and access token setup

### What you need

Create a Google **OAuth client ID** and **client secret**, then put them in
`.env.local`. An access token is temporary and is issued by Google when a user
signs in; it is not the client secret and is not a configuration value you create
once. The ID token identifies the user; an access token authorizes Google API
calls. Auth.js performs the authorization-code exchange and establishes the
pchat session. See [Google's OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect).

This app requests basic identity scopes (`openid email profile`). It does not
request Gmail, Drive, or offline access, persist Google access/refresh tokens,
or expose them through the browser session. Calling Google APIs later requires
additional scopes and server-side token storage/renewal. See
[Google's OAuth web server guide](https://developers.google.com/identity/protocols/oauth2/web-server).

### 1. Configure a Google Cloud project

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/) with the
   Google account that will own the application. Create or select a project
   for pchat.
2. Open **Google Auth platform**. Complete **Get started** if shown. In
   **Branding**, set the app name to `pchat`, select a support email, and provide
   the requested developer contact email.
3. In **Audience**, choose **External** to allow personal Google accounts.
   **Internal** is for accounts within a Google Workspace organization.
   For development, keep the app in Testing and add your Google email under
   **Test users**. Add other developers' accounts as needed. Basic-identity-only
   apps have exceptions to Google's testing restrictions; adding your test
   accounts explicitly keeps the configuration ready if more scopes are added.
4. In **Data Access**, use only `openid`,
   `https://www.googleapis.com/auth/userinfo.email`, and
   `https://www.googleapis.com/auth/userinfo.profile` for this login flow.

Google documents these settings in
[OAuth consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent)
and [audience settings](https://support.google.com/cloud/answer/15549945?hl=en).

### 2. Create the OAuth client

1. Open **Google Auth platform → Clients → Create client**.
2. Choose **Web application**, and name it `pchat local`.
3. Under **Authorized JavaScript origins**, add `http://localhost:3000`.
   The server redirect flow primarily uses the redirect URI below.
4. Under **Authorized redirect URIs**, add exactly:

   ```text
   http://localhost:3000/api/auth/callback/google
   ```

5. Create the client and save its **Client ID** and **Client secret** privately.
   If offered a credentials download, store it outside the repository.

Use the URL above without a trailing slash. If the port or hostname changes,
register the matching URI and update `AUTH_URL`. `localhost` and `127.0.0.1` are
different OAuth hosts. See [Google's client creation guide](https://developers.google.com/workspace/guides/create-credentials)
and [Auth.js Google configuration](https://authjs.dev/getting-started/providers/google).

### 3. Configure pchat locally

The initial setup created an ignored `.env.local` with a random `AUTH_SECRET`
and blank Google credentials. Preserve that secret and fill in the Google values.
On a fresh checkout, copy `.env.example` to `.env.local` first:

```sh
# Git Bash / WSL
cp .env.example .env.local
```

Or in PowerShell:

```powershell
Copy-Item .env.example .env.local
```

If you copied the template, generate a session secret locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Paste that output into `AUTH_SECRET`. The completed file should contain:

```dotenv
AUTH_SECRET=<your-generated-random-secret>
AUTH_GOOGLE_ID=<your-client-id>.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=<your-client-secret>
AUTH_URL=http://localhost:3000
```

Replace every placeholder. `AUTH_SECRET` belongs to pchat and is separate from
Google's client secret. Keep these variables server-side; do not prefix them
with `NEXT_PUBLIC_`. `.env.local` is ignored by Git. Never paste credentials
or access tokens into chat, source code, or screenshots. The checked-in
`.env.example` intentionally has empty credentials.

Restart `npm run dev` after editing environment variables. Before all three
credentials are set, the app disables Google sign-in and auth endpoints return
HTTP 503. These environment names follow the
[Auth.js setup guide](https://authjs.dev/getting-started/installation?framework=Next.js).

### 4. Verify login

1. Open http://localhost:3000 in a normal browser.
2. Click **Sign in with Google**, choose your account, and complete Google's
   consent flow if prompted.
3. On returning to pchat, check that your name/email and **Sign out** appear.
4. Refresh to confirm the session persists, then sign out and confirm the
   sign-in button returns. Signing out of pchat does not sign you out of Google.

The Google Cloud project/client cannot be created from this repository: those
steps require the project owner's Google Console access. Unit tests check UI
states and actions; completing a real OAuth login requires valid credentials
and browser interaction.

### Troubleshooting and deployment

- **`redirect_uri_mismatch`**: compare Google's registered redirect URI with
  `AUTH_URL` plus `/api/auth/callback/google`; scheme, host, port, path, and
  trailing slash must match. Restart after changing `.env.local`.
- **`invalid_client`**: check that the ID and secret belong to the same Web
  application client, and that neither contains a placeholder.
- **Access denied**: check Audience/test accounts and any Google Workspace
  administrator restrictions. Cancelled sign-in can be retried from the home
  page.
- **Sign-in disabled**: confirm `AUTH_SECRET`, `AUTH_GOOGLE_ID`, and
  `AUTH_GOOGLE_SECRET` are non-empty in `.env.local`, then restart.
- **Production**: create a separate production OAuth client, register
  `https://YOUR_DOMAIN/api/auth/callback/google`, set `AUTH_URL` to the HTTPS
  origin, and configure all three secrets in the hosting environment. Review
  Google's audience, publishing, and branding requirements before opening
  access to users. Auth.js may require `AUTH_TRUST_HOST=true` behind a trusted
  reverse proxy; use it only when that proxy controls forwarded host headers.

The chat pages and every chat/media API authenticate the session on the server
and check membership before returning history, accepting messages, or serving
attachments. Google account IDs identify users; changing a display name or email
does not change chat ownership.


## Using private chats

1. Sign in with Google and click **New chat**. Your chats appear in the left
   sidebar; select any conversation there to continue it.
2. In the new conversation, click **Get invitation link**, then **Copy link**.
   Send that URL to one friend. The link expires after seven days. Making another
   invitation invalidates the previous link.
3. Your friend opens the URL, signs in with Google, and clicks **Join chat**.
   Google login returns them to the same invitation. Joining is an explicit
   action so previewing a link does not accidentally claim the second seat.
4. Both people can send messages and attach JPEG, PNG, GIF, WebP images or MP4,
   WebM videos, up to **25 MB per file** and one attachment per message. Browser
   playback depends on the video codec; MP4 with H.264 is widely supported.
5. Messages refresh every two seconds and the sidebar every three seconds.
   Reopen a chat to see its saved history. The most recent 100 messages load
   first; **Load older messages** retrieves earlier history.

A chat allows exactly two Google accounts. The first other account to use the
invitation claims the second seat, so share the URL privately. Existing members
can reopen a used invitation; another person cannot join or read the chat.
Sign-out does not delete any chats or media.

**Sharing outside your computer:** a `localhost` URL only works on the computer
that opens it. To chat with someone remotely, run pchat on a reachable HTTPS
host, configure `AUTH_URL` for that host, and register its Google OAuth callback
as described above. The invitation uses the origin of the browser page. Both
people must access the same deployed instance, with matching OAuth settings.

## Persistent storage and deployment

- Default directory: `data/` under the project root, ignored by Git.
- Database: `data/pchat.sqlite` (users, memberships, invitation hashes, messages,
  attachment metadata). SQLite may also create `-wal` and `-shm` files.
- Uploads: `data/uploads/`, with generated storage filenames. Originals are
  displayed in the conversation, while file contents are checked to reject
  unsupported formats even when the filename/MIME label says otherwise.
- Optional `PCHAT_DATA_DIR`: an absolute path to a private, writable directory.
  Restart the server after changing it. Changing the directory selects a
  different database; migrate the existing directory if you want its history.
- Keep this directory on persistent storage and preserve it across updates.
  Stop the server before copying the entire directory for a backup. Protect
  backups as private user data. Chat content and media are not encrypted at rest.

Run this version on a Node server with a persistent local disk or mounted
volume. Ephemeral/serverless filesystem deployments will lose data and are
not supported by this storage design. Multiple independent replicas do not
share chat history. A larger deployment should replace local SQLite/files
with a shared database and authenticated object storage.

Media is served through `/api/media/[id]` only after session and chat-membership
checks, with private/no-store caching and HTTP byte-range support for videos.
Uploads are never put in `public/`. Chat mutation routes reject cross-origin
requests. Polling stops on unmount; failed messages retain their text/file for
retry and retries use a message identifier to avoid duplicates.

Additional source files:

- `src/lib/chat-store.ts`: SQLite schema, two-person invitations, memberships,
  message history and attachment metadata.
- `src/lib/chat-api.ts`: authenticated requests and mutation origin checks.
- `src/lib/chat-media.ts`: bounded uploads, format detection, storage, byte ranges.
- `src/components/chat-workspace.tsx`: sidebar, invitation link, conversation,
  polling, history pagination, message composer and media previews.
- `src/app/chat/[id]/page.tsx`: member-only conversation page.
- `src/app/invite/[token]/page.tsx`: Google login and invitation confirmation.
- `src/app/api/chats/`: chat creation/listing, invitations and message APIs.
- `src/app/api/media/[id]/route.ts`: authenticated media streaming.

Tests cover two-person membership, outsider rejection, invitation expiration,
message retries, history pagination, database reopening, private image uploads,
media byte ranges, invalid files, oversized requests, and anonymous/cross-origin
access. Real Google OAuth still requires configured credentials and browser
interaction with two Google accounts.

After `npm run build`, use `npm run test:http` for an HTTP integration check.
It starts a temporary server on port 3107 with isolated test sessions and a
temporary data directory, exercises invitations and both message directions,
checks private uploads/ranges, then stops the server and removes its test data.
It does not use your Google credentials or add chats to your normal database.
The video fixture tests container storage/streaming, not browser codec playback.

## Codex conversation transcripts

This project's Codex conversations are saved in
[`docs/codex/transcripts/index.md`](docs/codex/transcripts/index.md).
Each session has a readable Markdown transcript and a JSON copy containing
user messages, assistant replies, and visible progress updates. Internal
instructions, reasoning, and tool traces are excluded.

Windows and WSL user-level Codex settings on this computer invoke
`scripts/save_codex_transcript.py` after completed turns. The exporter only
writes sessions whose working directory is this repository or a subdirectory.
The existing Windows notification command is chained after the export.
Restart/reopen Codex to load the new notification settings. A temporary watcher
keeps the current conversation updated until six hours of inactivity.
`AGENTS.md` also instructs future Codex sessions to refresh the transcripts.

To refresh all available conversations for this repository manually:

```bash
# WSL
python3 scripts/save_codex_transcript.py --all
```

```powershell
# Windows
python scripts/save_codex_transcript.py --all
```

Use `--session-id <id>` for one conversation, `--sessions-dir <directory>`
to search an additional Codex sessions directory, or `--watch` to keep exporting
while a session is active. Source records remain in the local Codex sessions
directory; deleting those records prevents later re-export. These repository
files contain the conversation text and can be reviewed and committed with
the project.

The automatic notification is configured in each user's `.codex/config.toml`,
with backups named `config.toml.before-pchat-transcripts`. These machine settings
are outside the repository. A different computer needs its own `notify` command
pointing to this script and its local Python executable; see the
[Codex advanced configuration guide](https://learn.chatgpt.com/docs/config-file/config-advanced).
