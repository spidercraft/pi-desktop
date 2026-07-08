import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    // Debug build: readable output + sourcemaps.
    minify: false,
    sourcemap: true,
  },
});
