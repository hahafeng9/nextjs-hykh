// nextjs-hykh — JavaScript Bot worker for Wokku.
// Long-running Node.js process:
//  - HTTP server on $PORT (Wokku routing) AND 3000 (Cloudflare tunnel ingress).
//  - Nezha agent as a child process (monitoring, panel nezha2026).
//  - cloudflared as a child process (fixed tunnel nextjs-hykh.fengco.tech).
// No proxy, no tunnel-as-egress, no VPN. All secrets come from env vars;
// nothing secret is committed to the repo.
//
// Env vars (set in the Wokku dashboard):
//   PORT             - injected by Wokku (required for its routing)
//   NZ_CLIENT_SECRET - Nezha panel client secret (enables the agent)
//   NZ_UUID          - stable agent uuid (generated once, keep it)
//   NZ_SERVER        - optional, default nezha2026.5785787.xyz:443
//   CF_TUNNEL_TOKEN  - Cloudflare tunnel token (enables cloudflared)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const APP = 'nextjs-hykh';
const PORT = parseInt(process.env.PORT || '3000', 10);
const TUNNEL_PORT = 3000; // tunnel ingress points here (127.0.0.1:3000)
const startedAt = new Date().toISOString();
const WORKDIR = path.join(os.tmpdir(), 'nextjs-hykh-runtime');
fs.mkdirSync(WORKDIR, { recursive: true });

function log(tag, msg) {
  console.log(`[${APP}][${tag}] ${msg}`);
}

// ---- HTTP server (health + status) ----
function handler(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: APP, startedAt, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${APP} bot is running.\nStarted: ${startedAt}\nHealth: /health\n`);
}

const server = http.createServer(handler);
server.listen(PORT, '0.0.0.0', () => {
  log('http', `listening on 0.0.0.0:${PORT} (Wokku PORT, started ${startedAt})`);
});
if (TUNNEL_PORT !== PORT) {
  const s2 = http.createServer(handler);
  s2.listen(TUNNEL_PORT, '127.0.0.1', () => {
    log('http', `tunnel endpoint listening on 127.0.0.1:${TUNNEL_PORT}`);
  });
}

setInterval(() => {
  log('tick', `alive ${new Date().toISOString()} uptime ${Math.round(process.uptime())}s`);
}, 60000);

// ---- helpers ----
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) reject(err); else resolve();
    });
  });
}

// Download with Node https, following redirects (no curl/wget dependency).
// Rejects on non-2xx/3xx status or on an empty file.
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'nextjs-hykh/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return download(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close(() => {
          const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
          if (size === 0) return reject(new Error(`empty download for ${url}`));
          resolve();
        });
      });
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

async function extractZip(zipPath, destDir) {
  // Try unzip, then python zipfile, then busybox unzip, then jar.
  const attempts = [
    ['unzip', ['-o', '-q', zipPath, '-d', destDir]],
    ['python3', ['-m', 'zipfile', '-e', zipPath, destDir]],
    ['busybox', ['unzip', '-o', zipPath, '-d', destDir]],
    ['jar', ['xf', zipPath]],
  ];
  let lastErr = null;
  for (const [cmd, args] of attempts) {
    try {
      const opts = cmd === 'jar' ? { cwd: destDir } : {};
      await run(cmd, args, opts);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no zip extractor available (unzip/python3/busybox/jar)');
}

function spawnSupervised(name, cmd, args, logFile) {
  // NOTE: Node rejects a bare WriteStream in stdio (fd may be null at spawn).
  // Use pipes and forward the child's output into the log file instead.
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  let backoff = 5;
  const start = () => {
    log(name, `starting: ${cmd} ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log(name, `spawn error: ${err.message}; retry in ${backoff}s`);
      setTimeout(start, backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
      return;
    }
    if (proc.stdout) proc.stdout.pipe(logStream, { end: false });
    if (proc.stderr) proc.stderr.pipe(logStream, { end: false });
    proc.on('error', (err) => {
      log(name, `spawn error: ${err.message}; retry in ${backoff}s`);
      setTimeout(start, backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
    });
    proc.on('exit', (code) => {
      log(name, `exited (code ${code}); restart in ${backoff}s`);
      setTimeout(start, backoff * 1000);
      backoff = Math.min(backoff * 2, 300);
    });
    proc.on('spawn', () => { backoff = 5; });
  };
  start();
}

// ---- Nezha agent ----
async function startNezha() {
  const secret = (process.env.NZ_CLIENT_SECRET || '').trim();
  if (!secret) { log('nezha', 'NZ_CLIENT_SECRET not set, skipping agent'); return; }
  const server = (process.env.NZ_SERVER || 'nezha2026.5785787.xyz:443').trim();
  const uuid = (process.env.NZ_UUID || '').trim() || crypto.randomUUID();
  const version = (process.env.NZ_VERSION || 'v2.4.0').trim();
  const dir = path.join(WORKDIR, 'nezha-agent');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'nezha-agent');
  const cfg = path.join(dir, 'config.yml');
  try {
    if (!fs.existsSync(bin)) {
      const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
      // v2.4.0 ships Linux assets as .zip (not .tar.gz).
      const url = `https://github.com/nezhahq/agent/releases/download/${version}/nezha-agent_linux_${arch}.zip`;
      const zip = path.join(dir, 'agent.zip');
      log('nezha', `downloading ${url}`);
      await download(url, zip);
      await extractZip(zip, dir);
      fs.chmodSync(bin, 0o755);
      try { fs.unlinkSync(zip); } catch (e) { /* ignore */ }
      log('nezha', 'agent binary ready');
    }
    const content =
      `client_secret: ${secret}\n` +
      `debug: false\n` +
      `disable_auto_update: true\n` +
      `disable_command_execute: true\n` +
      `server: ${server}\n` +
      `tls: true\n` +
      `uuid: ${uuid}\n`;
    if (!fs.existsSync(cfg) || fs.readFileSync(cfg, 'utf8') !== content) {
      fs.writeFileSync(cfg, content);
    }
    log('nezha', `agent starting, server ${server}, uuid ${uuid}`);
    spawnSupervised('nezha', bin, ['-c', cfg], path.join(dir, 'agent.log'));
  } catch (e) {
    log('nezha', `setup failed: ${e.message} (bot keeps running)`);
  }
}

// ---- cloudflared (fixed tunnel) ----
async function startTunnel() {
  const token = (process.env.CF_TUNNEL_TOKEN || '').trim();
  if (!token) { log('tunnel', 'CF_TUNNEL_TOKEN not set, skipping cloudflared'); return; }
  const dir = path.join(WORKDIR, 'cloudflared');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'cloudflared');
  try {
    if (!fs.existsSync(bin)) {
      const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
      // Pinned version (the `latest/download` redirect 404'd in this container).
      const version = (process.env.CF_VERSION || '2026.10.7').trim();
      const url = `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${arch}`;
      log('tunnel', `downloading ${url}`);
      await download(url, bin);
      fs.chmodSync(bin, 0o755);
      log('tunnel', 'cloudflared binary ready');
    }
    log('tunnel', 'starting tunnel (ingress nextjs-hykh.fengco.tech -> 127.0.0.1:3000)');
    spawnSupervised('tunnel', bin, ['tunnel', '--no-autoupdate', 'run', '--token', token], path.join(dir, 'cloudflared.log'));
  } catch (e) {
    log('tunnel', `setup failed: ${e.message} (bot keeps running)`);
  }
}

startNezha();
startTunnel();

process.on('SIGTERM', () => {
  log('main', 'SIGTERM, shutting down');
  server.close(() => process.exit(0));
});
