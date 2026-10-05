// "Phone mode": start the store and a free Cloudflare Quick Tunnel so you can open it on your
// phone from anywhere, over HTTPS (so the in-page camera scanner works too).
// Needs `cloudflared` installed. Without it, falls back to your Wi-Fi address.
//
//   npm run phone        (or double-click phone.bat on Windows)
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');

process.chdir(path.join(__dirname, '..'));
process.env.PORT = process.env.PORT || '3000';
process.env.OPEN_BROWSER = 'false';
const port = process.env.PORT;

function showPhoneLink(url, note) {
  // Wait a moment so this prints after the store's own startup messages.
  setTimeout(() => printPhoneLink(url, note), 800);
}

function printPhoneLink(url, note) {
  QRCode.toString(url, { type: 'terminal', small: true }, (err, qr) => {
    console.log('\n  ==================================================================');
    console.log('  📱  Scan this with your phone camera to open the store:\n');
    if (!err) console.log(qr.split('\n').map((l) => `      ${l}`).join('\n'));
    console.log(`  ${url}`);
    if (note) console.log(`\n  ${note}`);
    console.log(`  Log in with the demo accounts (password: ${process.env.SEED_PASSWORD ? 'your SEED_PASSWORD' : 'password123'}). Press Ctrl+C to stop.`);
    console.log('  ==================================================================\n');
  });
}

function lanFallback(reason) {
  const ip = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  console.log(`\n  ${reason}`);
  console.log('  Using your Wi-Fi address instead: the phone must be on the SAME Wi-Fi as this PC.');
  console.log('  (If Windows asks whether to allow Node.js on networks, click Allow.)');
  if (!ip) return console.log('  Could not find this PC\'s network address.');
  const url = `http://${ip}:${port}`;
  Object.assign(require('../src/config').settings, { appUrl: url, appUrlFixed: true });
  showPhoneLink(url, 'The camera button on the Check-in page needs HTTPS, so it won\'t work this way. Use your phone\'s own camera app to scan order QR codes instead.');
}

// Start the store itself (same as npm start).
require('../server.js');

const hasCloudflared = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!hasCloudflared) {
  lanFallback(
    'cloudflared is not installed, so the store can only be reached on your Wi-Fi.\n'
    + '  To use it from anywhere (and over HTTPS), install it once, then run this again:\n'
    + '    Windows:  winget install --id Cloudflare.cloudflared\n'
    + '    Mac:      brew install cloudflared',
  );
} else {
  console.log('  Starting a Cloudflare Quick Tunnel (free, no account)…');
  const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    shell: process.platform === 'win32',
  });
  let found = false;
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !found) {
      found = true;
      // QR codes and email links should point at the public address from now on.
      Object.assign(require('../src/config').settings, { appUrl: m[0], appUrlFixed: true });
      showPhoneLink(m[0], 'This address changes every time you start phone mode, and anyone who has it can open the store.\n  It\'s for trying things out with demo data only.');
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('exit', (code) => {
    if (found) return;
    found = true; // stop waiting; fall back to Wi-Fi instead
    lanFallback(`The tunnel could not start (exit code ${code}). A company network or firewall may be blocking it.`);
  });
  const stop = () => { tunnel.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setTimeout(() => { if (!found) console.log('  Still waiting for the tunnel… (check your internet connection)'); }, 20000);
}
