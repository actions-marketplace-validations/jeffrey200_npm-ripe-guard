```
▗▖  ▗▖▗▄▄▖ ▗▖  ▗▖    ▗▄▄▖ ▗▄▄▄▖▗▄▄▖ ▗▄▄▄▖     ▗▄▄▖▗▖ ▗▖ ▗▄▖ ▗▄▄▖ ▗▄▄▄
▐▛▚▖▐▌▐▌ ▐▌▐▛▚▞▜▌    ▐▌ ▐▌  █  ▐▌ ▐▌▐▌       ▐▌   ▐▌ ▐▌▐▌ ▐▌▐▌ ▐▌▐▌  █
▐▌ ▝▜▌▐▛▀▘ ▐▌  ▐▌    ▐▛▀▚▖  █  ▐▛▀▘ ▐▛▀▀▘    ▐▌▝▜▌▐▌ ▐▌▐▛▀▜▌▐▛▀▚▖▐▌  █
▐▌  ▐▌▐▌   ▐▌  ▐▌    ▐▌ ▐▌▗▄█▄▖▐▌   ▐▙▄▄▖    ▝▚▄▞▘▝▚▄▞▘▐▌ ▐▌▐▌ ▐▌▐▙▄▄▀
```

> Block npm packages younger than 24 hours — drop it into any GitHub Actions workflow in one line.

Many supply-chain attacks exploit the brief window right after a malicious package is pushed to npm — before security scanners catch it. **npm-ripe-guard** enforces a 24-hour quarantine on all new versions.

---

## Usage in GitHub Actions

```yaml
steps:
  - uses: your-org/npm-ripe-guard@v1

  - name: Install dependencies
    run: npm ci   # automatically routed through the proxy
```

That's it. The action starts the proxy in the background and sets `NPM_CONFIG_REGISTRY` for every subsequent step.

**Custom port:**

```yaml
- uses: your-org/npm-ripe-guard@v1
  with:
    port: 5000
```

---

## How it works

```
npm install foo  →  npm-ripe-guard  →  registry.npmjs.org
                          │
                          ├─ fetch metadata (cached 5 min)
                          ├─ resolve dist-tag  →  exact version
                          ├─ check publish timestamp
                          │
                          ├─ published < 24 h ago  →  403 Forbidden
                          └─ published ≥ 24 h ago  →  stream response
```

- Scoped packages (`@org/pkg`) and dist-tags (`latest`, `next`, …) are handled correctly
- If no timestamp is available the package is allowed through
- Non-GET requests (publish, unpublish) are forwarded without inspection

---

## What a blocked install looks like

```
$ npm install some-brand-new-package

npm error code E403
npm error {
npm error   "error": "ERR_PACKAGE_TOO_NEW",
npm error   "message": "some-brand-new-package@1.0.0 was published 37 minute(s) ago.
npm error              Packages must be at least 24 hours old.
npm error              Installation will be available at 2024-01-16T09:37:00.000Z.",
npm error   "package": "some-brand-new-package",
npm error   "version": "1.0.0",
npm error   "publishedAt": "2024-01-15T09:37:00.000Z",
npm error   "availableAt": "2024-01-16T09:37:00.000Z"
npm error }
```

---

## Local usage

**Requires Node.js ≥ 18**

```bash
git clone https://github.com/your-org/npm-ripe-guard
cd npm-ripe-guard
npm install && npm run build
npm start
```

Point npm at the proxy:

```bash
# one-off
npm install --registry http://localhost:4873 <package>

# persistent (current user)
npm config set registry http://localhost:4873

# per project
echo "registry=http://localhost:4873" >> .npmrc
```

Revert: `npm config delete registry`

---

## Development

```bash
npm run dev       # start with hot-reload via tsx
npm run typecheck # type-check without building
npm run build     # bundle to dist/server.js (commit this)
```

> **Note:** `dist/server.js` must be committed. The GitHub Action references it directly at runtime.

---

## Health check

```bash
curl http://localhost:4873/health
```

```json
{ "status": "ok", "uptime": 42, "cachedPackages": 3 }
```

---

## Configuration

| Variable    | Default | Description                                           |
|-------------|---------|-------------------------------------------------------|
| `PORT`      | `4873`  | Port to listen on                                     |
| `LOG_LEVEL` | `info`  | Log verbosity (`trace` `debug` `info` `warn` `error`) |

---

## Releasing a new version

```bash
npm run build
git add dist/
git commit -m "chore: rebuild dist"
git tag v1.0.0
git push origin main --tags
```

The release workflow will:
1. Re-verify the build is clean
2. Create a GitHub Release with auto-generated notes
3. Move the floating `v1` tag to the new commit so `@v1` always resolves to the latest patch

---

## Running as a service (Linux / systemd)

Create `/etc/systemd/system/npm-ripe-guard.service`:

```ini
[Unit]
Description=npm-ripe-guard registry proxy
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/npm-ripe-guard
ExecStart=/usr/bin/node /opt/npm-ripe-guard/dist/server.js
Restart=on-failure
Environment=PORT=4873

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now npm-ripe-guard
```

System-wide npm config — add to `/etc/npmrc`:

```
registry=http://localhost:4873
```
