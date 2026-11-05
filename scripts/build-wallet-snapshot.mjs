// Builds a self-contained, VISUAL-ONLY snapshot of the real CustomerWallet screen.
//   cd relay-sandbox && node scripts/build-wallet-snapshot.mjs [tester-code]
// It server-renders the actual src/CustomerWallet.jsx with the current populated simulated fixture read from the local
// synthetic preview server (127.0.0.1:4322, read-only: one tester sign-in and one state read), inlines the built
// stylesheets and the two small fonts, refers to the logo by a relative file (docs/wallet-visual-snapshot-assets/), disables every control,
// and writes docs/wallet-visual-snapshot.html with no scripts and no network requests.
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

const require = createRequire(process.cwd() + '/package.json');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {createServer} = require('vite');
const ORIGIN = 'http://127.0.0.1:4322', CODE = process.argv[2] ?? 'relay-preview-alice';
const OUT = new URL('../docs/wallet-visual-snapshot.html', import.meta.url);

async function readState() {
  const login = await fetch(ORIGIN + '/api/login', {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN}, body: JSON.stringify({code: CODE})});
  if (!login.ok) throw new Error('Could not sign in to the local synthetic preview (is it running?).');
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const res = await fetch(ORIGIN + '/api/state', {headers: {cookie}});
  const state = await res.json();
  if (!state.customerWallet?.wallet) throw new Error('This tester has no populated wallet to show.');
  return state.customerWallet;
}

const dist = new URL('../dist/', import.meta.url);
const asset = p => readFileSync(new URL(p.replace(/^\//, ''), dist));
const dataUri = (p, mime) => `data:${mime};base64,${asset(p).toString('base64')}`;
const index = readFileSync(new URL('index.html', dist), 'utf8');
const css = [...index.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map(m => asset(m[1]).toString('utf8')).join('\n')
  .replace(/url\((\/assets\/[^)]+\.woff2)\)/g, (_, p) => `url(${dataUri(p, 'font/woff2')})`)
  .replace(/url\((\/assets\/[^)]+\.png)\)/g, (_, p) => `url(${dataUri(p, 'image/png')})`);
// The logo is a 1 MB image, so the page points at a local copy instead of embedding it. Put the original at
// docs/wallet-visual-snapshot-assets/eupova-mark.png; without it the page simply shows no logo.
const mark = 'wallet-visual-snapshot-assets/eupova-mark.png';

const cw = await readState();
const vite = await createServer({root: process.cwd(), configFile: false, logLevel: 'silent', server: {middlewareMode: true, hmr: false, watch: null}, appType: 'custom', optimizeDeps: {noDiscovery: true, include: []}});
let body;
try {
  const {default: CustomerWallet} = await vite.ssrLoadModule('/src/CustomerWallet.jsx');
  body = renderToStaticMarkup(React.createElement(CustomerWallet, {state: {account: null, agents: [], customerWallet: cw}, act: async () => null, busy: false, error: '', open: () => {}, onBridge: () => {}}));
} finally { await vite.close(); }

// Visual only: every control is disabled, forms cannot submit, nothing can run.
body = body.replace(/<(button|input|select|textarea)(?=[\s>\/])/g, '<$1 disabled aria-disabled="true"').replace(/<form(?=[\s>])/g, '<form inert');
const stamp = new Date().toISOString();
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: file: 'self'; font-src data:; form-action 'none'">
<title>Eupova My wallet: visual-only snapshot</title>
<style>${css}</style>
<style>
.snap-banner{position:sticky;top:0;z-index:5;display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff3d8;color:#5c3f08;border-bottom:1px solid #e8c77a;padding:10px 20px;font:600 13px/1.4 Manrope,Inter,sans-serif}
.snap-banner img{width:24px;height:24px;border-radius:6px}.snap-banner span{font-weight:500}
.snap-page{max-width:880px;margin:0 auto;padding:24px 20px 60px}
.snap-page h1{margin:0 0 6px;font-size:28px}.snap-page>header p{margin:0 0 20px;color:var(--muted)}
.snap-page button:disabled,.snap-page input:disabled,.snap-page select:disabled{cursor:not-allowed}
</style></head>
<body>
<div class="snap-banner" role="note"><img src="${mark}" alt=""><strong>VISUAL-ONLY SNAPSHOT</strong><span>A picture of the built My wallet screen with simulated test data from ${stamp.slice(0, 16).replace('T', ' ')} UTC. Nothing here works: controls are switched off, there are no scripts and no network requests. Not a live or funded wallet.</span></div>
<main class="snap-page" id="main"><header><h1>Your Eupova wallet.</h1><p>Your wallet, your approval. Add money, send, and decide what connected tools may ask for.</p></header>
${body}
</main></body></html>
`;
// Hard checks: nothing that could load, run or send anything.
if (/<script|<link\b|\bhref="|\bsrc="(?!data:|wallet-visual-snapshot-assets\/)|url\((?!data:|#|")|@import|https?:\/\/[^\s"')]*\.(js|css|png|woff2)/i.test(html)) throw new Error('Snapshot would load something external.');
if (/<(button|input|select|textarea)(?![^>]*\bdisabled)/.test(html)) throw new Error('An enabled control is left in the snapshot.');
writeFileSync(OUT, html);
console.log(`Wrote ${OUT.pathname} (${(html.length / 1024).toFixed(0)} KB, sha256 ${createHash('sha256').update(html).digest('hex').slice(0, 16)}…) for ${cw.wallet.label}`);
