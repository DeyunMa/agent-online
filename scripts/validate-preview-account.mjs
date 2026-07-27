import { readFile } from "node:fs/promises";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const previewAccountId = config.env?.preview?.account_id;
const configuredAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (typeof previewAccountId !== "string" || !/^[a-f0-9]{32}$/u.test(previewAccountId)) {
  console.error("wrangler.jsonc env.preview.account_id must explicitly pin the Preview account.");
  process.exitCode = 1;
} else if (configuredAccountId && configuredAccountId !== previewAccountId) {
  console.error("CLOUDFLARE_ACCOUNT_ID conflicts with wrangler.jsonc env.preview.account_id.");
  process.exitCode = 1;
} else {
  console.log(`Preview Cloudflare account target is pinned (${previewAccountId}).`);
}
