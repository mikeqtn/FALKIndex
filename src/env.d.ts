/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    catalogue?: ReturnType<typeof import('./lib/data.ts').getCatalogue>;
  }
}
interface ImportMetaEnv {
  readonly PUBLIC_SITE_URL?: string;
}
