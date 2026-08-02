# Deploying the Aegis Remote relay (permanent public URL)

The relay is a small Node WebSocket server that also serves the console. Deploy
it once to an always-on host and you get a stable URL like
`https://aegis-relay.up.railway.app` that survives your PC sleeping.

It reads two env vars:
- `PORT` — provided automatically by the host.
- `AEGIS_KEY` — the access key. **Set a strong value.**

A `Dockerfile` is included so the host installs only `ws` (not Electron).

---

## Option A — Railway (easiest, no GitHub needed)

1. Install the CLI (once):
   ```bash
   npm install -g @railway/cli
   ```
2. Log in (opens your browser to approve):
   ```bash
   railway login
   ```
3. From the `aegis-remote` folder, create a project and deploy the local code:
   ```bash
   railway init          # name it e.g. "aegis-relay"
   railway up            # uploads + builds the Dockerfile + deploys
   ```
4. Set the access key and generate a public domain:
   ```bash
   railway variables --set AEGIS_KEY=PUT-A-STRONG-KEY-HERE
   railway domain        # prints your public https URL
   ```

Your relay is now at `https://<something>.up.railway.app`.

## Option B — Render (via GitHub)

1. Push this `aegis-remote` folder to a GitHub repo.
2. In Render: **New → Blueprint**, connect the repo (it reads `render.yaml`).
3. Set `AEGIS_KEY` to a strong value when prompted. Deploy.
4. Render gives you `https://aegis-relay.onrender.com`.

## Option C — Fly.io

```bash
fly launch --no-deploy      # detects the Dockerfile
fly secrets set AEGIS_KEY=PUT-A-STRONG-KEY-HERE
fly deploy
```

---

## After deploy — point the agent + console at it

1. **Console:** just open your new URL (`https://<relay>/`) — it auto-connects to
   its own `wss://<relay>` and serves the console. No change needed.
2. **Agent:** re-bake the permanent URL so installed agents connect to it:
   - Edit `agent/config.default.json`:
     ```json
     { "relay": "wss://<your-relay-domain>", "key": "PUT-A-STRONG-KEY-HERE", "enabled": true }
     ```
   - Rebuild the agent + installer:
     ```bash
     npm run build-agent
     "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
     ```
   - Distribute the new `release/AegisRemoteSetup.exe`.

Now the link is permanent: it works whenever the target PC is awake with the
agent installed, regardless of your PC.
