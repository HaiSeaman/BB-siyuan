import { resolve } from "path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const isDev = process.env.NODE_ENV === "development";
const outputDir = isDev ? "dev" : "dist";

export default defineConfig({
    resolve: {
        alias: { "@": resolve(import.meta.dirname, "src") },
    },
    plugins: [
        svelte(),
        viteStaticCopy({
            targets: [
                { src: "./plugin.json", dest: "./" },
                { src: "./icon.png", dest: "./" },
                { src: "./net-proxy.cjs", dest: "./" },
            ],
        }),
    ],
    build: {
        outDir: outputDir,
        emptyOutDir: true,
        minify: true,
        sourcemap: isDev ? "inline" : false,
        lib: {
            entry: resolve(import.meta.dirname, "src/index.ts"),
            fileName: () => "index.js",
            cssFileName: "index",
            formats: ["cjs"],
        },
        rollupOptions: {
            external: ["siyuan", "process"],
            output: {
                entryFileNames: "[name].js",
                assetFileNames: (asset) => (asset.name?.endsWith(".css") ? "index.css" : "[name][extname]"),
            },
        },
    },
});
