import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "GlossFrame - 画像翻訳と単語帳",
        short_name: "GlossFrame",
        description:
          "画像の文字を読み取り、翻訳・文法解説・単語帳・復習までをスマートフォンで行える学習アプリ。",
        lang: "ja",
        start_url: "/",
        display: "standalone",
        background_color: "#101917",
        theme_color: "#143c3a",
        orientation: "any",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globIgnores: ["**/models/**"],
        runtimeCaching: [
          {
            urlPattern: /\/models\/ocr\/v5-en-int8\//,
            handler: "CacheFirst",
            options: {cacheName:"paddle-v5-en-int8-v1", cacheableResponse:{statuses:[200]}},
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-cdn",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/tessdata\.projectnaptha\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-lang",
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "onnxruntime-web": fileURLToPath(new URL("./node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@client": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  worker: { format: "es" },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
