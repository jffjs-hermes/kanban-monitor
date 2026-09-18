import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
  // The app's server modules read boards through bun:sqlite and the app runs
  // on the bun runtime at deploy (spec ground truth: "single `bun run` process").
  // Leave `bun:sqlite` as an external resolved by the bun runtime instead of
  // trying to bundle it with Node's SSR build.
  ssr: { external: ['bun:sqlite'] },
  test: { include: ['src/**/*.test.ts'] },
});