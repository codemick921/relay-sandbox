import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: { '/api': 'http://127.0.0.1:4319' } }, build: { sourcemap: false, manifest:true, rollupOptions:{input:{app:"index.html",buyerConnection:"buyer-connection.html",walletAuth:"buyer-wallet-auth.html"}} } });
