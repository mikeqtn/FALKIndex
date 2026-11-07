/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    catalogue?: ReturnType<typeof import('./lib/data.ts').getCatalogue>;
    /** The signed-in reader's account, looked up once if a page asks. Absent under the dev server, which pages must allow. */
    account?: () => Promise<import('./accounts/contracts.ts').Account | null>;
  }
}
interface ImportMetaEnv {
  readonly PUBLIC_SITE_URL?: string;
}
