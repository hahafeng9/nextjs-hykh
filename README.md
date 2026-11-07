# nextjs-hykh — JS Bot for Wokku

A long-running JavaScript bot worker for Wokku (Bot / Worker project),
with Nezha monitoring and a fixed Cloudflare tunnel.

## Files
- `index.js` — bot worker + HTTP server (`/` status, `/health` JSON) + Nezha agent + cloudflared as child processes
- `package.json` — `npm start` runs `node index.js`

## How it works
- HTTP listens on `$PORT` (Wokku routing) and on `127.0.0.1:3000` (tunnel ingress).
- On start it downloads the Nezha agent (v2.4.0, linux) and cloudflared
  binaries into the OS temp dir, then supervises them (auto-restart).
  If the env vars below are missing, those two parts skip gracefully
  and the bot itself keeps running.
- No proxy / VPN / egress tunnel in this code (Wokku forbids open proxies).
  The Cloudflare tunnel only exposes this bot's own HTTP endpoint at
  `nextjs-hykh.fengco.tech`.

## Env vars (set in the Wokku dashboard, never commit secrets)
- `NZ_CLIENT_SECRET` — Nezha panel client secret (enables the agent)
- `NZ_UUID` — stable agent uuid (generated once, keep it)
- `NZ_SERVER` — optional, default `nezha2026.5785787.xyz:443`
- `CF_TUNNEL_TOKEN` — Cloudflare tunnel token for `wokku-nextjs-hykh`
  (tunnel id `44ad52b2-c01a-4232-9bd8-f94d874d757c`,
  ingress `nextjs-hykh.fengco.tech` -> `http://127.0.0.1:3000`)

## Deploy on Wokku
1. Log in at https://wokku.cloud (GitHub login).
2. App `nextjs-hykh` (already created) -> Resources -> connect this GitHub repo.
3. Set the env vars above in the app's environment.
4. Start command: `npm start` (or `node index.js`).
5. Check: Wokku URL `/` says "nextjs-hykh bot is running",
   `/health` returns `{"status":"ok",...}`;
   `https://nextjs-hykh.fengco.tech/health` should return the same
   once cloudflared is up.

## Notes
- Node >= 18. No dependencies, so `npm install` is a no-op.
- Nezha agent uuid and panel: old panel `nezha2026.5785787.xyz:443`.

## Deploy trigger
- 2026-11-07: connected to Wokku app nextjs-hykh; this commit triggers the first GitHub auto-deploy.
