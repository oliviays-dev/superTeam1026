import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 4311),
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 4310}`,
        changeOrigin: false,
      },
    },
  },
});
