import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
// base './' so the built site works from any static path (GitHub Pages subdir etc).
let build = 'dev';
try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git checkout */ }
export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(build) },
});
