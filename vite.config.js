import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
// Circle's browser SDK requires `jsonwebtoken`, which exists only for Node and throws on load in a browser
// (Object.create(undefined) inside util.inherits). It is used there only to decode a social-login id_token, which
// Eupova never requests, so the browser build points that one import at a small safe stand-in. See the file itself.
const jsonwebtokenBrowser = fileURLToPath(new URL('./src/vendor/jsonwebtoken-browser.mjs', import.meta.url));
export default defineConfig({
  resolve: { alias: { jsonwebtoken: jsonwebtokenBrowser } },
  server: { proxy: { '/api': 'http://127.0.0.1:4319' } },
  build: { sourcemap: false, manifest:true, rollupOptions:{input:{app:"index.html",buyerConnection:"buyer-connection.html",walletAuth:"buyer-wallet-auth.html",walletFlow:"buyer-wallet-flow.html",nativePrivy:"native-privy.html"}} }
});
