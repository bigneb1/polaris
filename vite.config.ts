import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Allow Cloudflare quick-tunnel hosts (and any tunnel) so the dev server is
    // reachable on a phone for live preview.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.up.railway.app'],
  },
})
