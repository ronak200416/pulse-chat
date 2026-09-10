const { spawn } = require('child_process');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;

console.log('\n======================================================');
console.log('⚡ Starting Secure Worldwide Public Tunnel...');
console.log('======================================================\n');
console.log('Connecting via built-in SSH tunnel to generate public HTTPS link...');

// Use Windows built-in OpenSSH with Pinggy / localhost.run for 100% direct HTTPS without IP prompts
const sshArgs = [
  '-p', '443',
  '-R0:localhost:' + PORT,
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ServerAliveInterval=30',
  'a.pinggy.io'
];

const sshProcess = spawn('ssh', sshArgs, {
  stdio: ['pipe', 'pipe', 'pipe']
});

let urlFound = false;

function extractUrl(text) {
  // Match https://*.pinggy.link or https://*.a.pinggy.link
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.(?:a\.)?pinggy\.link[^\s]*/i) ||
                text.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life[^\s]*/i) ||
                text.match(/https:\/\/[^\s]+\.loca\.lt/i);
  return match ? match[0] : null;
}

sshProcess.stdout.on('data', (data) => {
  const output = data.toString();
  const url = extractUrl(output);

  if (url && !urlFound) {
    urlFound = true;
    console.log('\n======================================================');
    console.log('🎉 YOUR CHAT APP IS LIVE WORLDWIDE (ZERO PROMPTS)!');
    console.log('======================================================');
    console.log(`🌍 Direct Public URL: \x1b[36m\x1b[1m${url}\x1b[0m`);
    console.log('Anyone across the globe can click this link to chat immediately!');
    console.log('======================================================\n');

    QRCode.toString(url, { type: 'terminal', small: true }, (err, qr) => {
      if (!err) {
        console.log('Scan with your phone to open instantly:');
        console.log(qr);
      }
    });
  }
});

sshProcess.stderr.on('data', (data) => {
  const output = data.toString();
  const url = extractUrl(output);
  if (url && !urlFound) {
    urlFound = true;
    console.log('\n======================================================');
    console.log('🎉 YOUR CHAT APP IS LIVE WORLDWIDE (ZERO PROMPTS)!');
    console.log('======================================================');
    console.log(`🌍 Direct Public URL: \x1b[36m\x1b[1m${url}\x1b[0m`);
    console.log('Anyone across the globe can click this link to chat immediately!');
    console.log('======================================================\n');

    QRCode.toString(url, { type: 'terminal', small: true }, (err, qr) => {
      if (!err) {
        console.log('Scan with your phone to open instantly:');
        console.log(qr);
      }
    });
  }
});

sshProcess.on('error', (err) => {
  console.error('SSH tunnel error:', err.message);
  console.log('\n💡 Fallback: You can also run:');
  console.log(`ssh -p 443 -R0:localhost:${PORT} a.pinggy.io`);
});

sshProcess.on('close', (code) => {
  if (!urlFound) {
    console.log('\nTunnel exited. Reconnecting or check your internet connection.');
  }
});

process.on('SIGINT', () => {
  console.log('\nClosing public tunnel...');
  sshProcess.kill();
  process.exit();
});
