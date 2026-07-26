import { rm } from "node:fs/promises";

const outputUrl = new URL("../dist/", import.meta.url);

if (outputUrl.pathname === "/" || !outputUrl.pathname.endsWith("/dist/")) {
  throw new Error(`Refusing to clean unexpected build path: ${outputUrl.pathname}`);
}

await rm(outputUrl, { force: true, recursive: true });
console.log("Cleaned dist build output.");
