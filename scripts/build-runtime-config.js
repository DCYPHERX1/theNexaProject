const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outputPath = path.join(root, "js", "runtime-config.js");

const publicConfig = {
  NEXA_SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXA_SUPABASE_URL || "",
  NEXA_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXA_SUPABASE_PUBLISHABLE_KEY || "",
  NEXA_RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY || process.env.NEXA_RECAPTCHA_SITE_KEY || "",
  NEXA_API_BASE_URL: process.env.NEXA_API_BASE_URL || "",
};

const body = [
  "// Generated at deploy time. Only browser-safe values belong here.",
  ...Object.entries(publicConfig).map(([key, value]) => `window.${key}=${JSON.stringify(value)};`),
  "",
].join("\n");

fs.writeFileSync(outputPath, body);
console.log(`Wrote ${path.relative(root, outputPath)}`);
