import { defineConfig } from 'astro/config';

// BASE_PATH is set by the GitHub Pages workflow ('/FALKIndex'); local builds serve from '/'.
export default defineConfig({
  site: 'https://mikeqtn.github.io',
  base: process.env.BASE_PATH ?? '/',
  trailingSlash: 'ignore',
});
