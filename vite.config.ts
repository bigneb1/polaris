import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // The Circle PIN/email SDK (@circle-fin/w3s-pw-web-sdk) bundles Node-oriented
    // deps (jsonwebtoken, firebase) that reference Buffer/process and Node built-in
    // modules. Without these polyfills they throw at runtime in the browser
    // ("Object prototype may only be an Object or null: undefined"). The SDK is
    // dynamically imported, so this only affects the chunk that loads when a user
    // opens the email wallet flow.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  server: {
    host: true,
    // Allow Cloudflare quick-tunnel hosts (and any tunnel) so the dev server is
    // reachable on a phone for live preview.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.up.railway.app'],
  },
})
