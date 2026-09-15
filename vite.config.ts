import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
// base './' so the built site works from any static path (GitHub Pages subdir etc).
let build = 'dev';
try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git checkout */ }
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [{
    // `vite build --mode native` (the iOS bundle) drops the web analytics tag:
    // the app runs from local files and collects nothing.
    name: 'strip-analytics',
    transformIndexHtml(html) {
      return mode === 'native' ? html.replace(/[ \t]*<script[^>]*umami[^>]*><\/script>\r?\n?/, '') : html;
    },
  }],
}));
