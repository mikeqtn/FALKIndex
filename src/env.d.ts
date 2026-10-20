/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    catalogue?: ReturnType<typeof import('./lib/data.ts').getCatalogue>;
  }
}
