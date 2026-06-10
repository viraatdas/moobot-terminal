// Build a Developer ID signed, notarized, stapled macOS DMG.
//
// Preferred local setup:
//   xcrun notarytool store-credentials moobot-terminal --apple-id <apple-id> --team-id 3C4383262W
//   APPLE_NOTARY_KEYCHAIN_PROFILE=moobot-terminal pnpm release:mac
//
// CI setup may instead provide either:
//   APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
// or:
//   APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productName = "Moobot Terminal";
const teamId = "3C4383262W";
const signingIdentity = `Developer ID Application: Viraat Das (${teamId})`;
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

function run(cmd, args, opts = {}) {
  const printable = opts.redact ? `${cmd} ${opts.redact}` : [cmd, ...args].join(" ");
  console.log(`\n$ ${printable}`);
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: process.env,
  });
  if (res.status !== 0) {
    if (opts.capture) {
      process.stdout.write(res.stdout ?? "");
      process.stderr.write(res.stderr ?? "");
    }
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? "";
}

function notarizationArgs() {
  const profile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE;
  if (profile) return ["--keychain-profile", profile];

  const apiKey = process.env.APPLE_API_KEY;
  const apiIssuer = process.env.APPLE_API_ISSUER;
  const apiKeyPath = process.env.APPLE_API_KEY_PATH;
  if (apiKey && apiIssuer && apiKeyPath) {
    if (!existsSync(apiKeyPath)) throw new Error(`APPLE_API_KEY_PATH does not exist: ${apiKeyPath}`);
    return ["--key", apiKeyPath, "--key-id", apiKey, "--issuer", apiIssuer];
  }

  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;
  if (appleId && password && appleTeamId) {
    return ["--apple-id", appleId, "--password", password, "--team-id", appleTeamId];
  }

  return null;
}

function latestDmg() {
  const dmgDir = path.join(root, "src-tauri", "target", "release", "bundle", "dmg");
  const prefix = `${productName}_${version}_`;
  const candidates = readdirSync(dmgDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".dmg"))
    .map((name) => path.join(dmgDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`No DMG found for ${version} in ${dmgDir}`);
  }
  return candidates[0];
}

const authArgs = notarizationArgs();
if (!authArgs) {
  console.error(`
Missing notarization credentials.

Local setup:
  xcrun notarytool store-credentials moobot-terminal --apple-id <apple-id> --team-id ${teamId}
  APPLE_NOTARY_KEYCHAIN_PROFILE=moobot-terminal pnpm release:mac

CI env setup:
  APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
or:
  APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
`);
  process.exit(1);
}

const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
if (!identities.includes(signingIdentity)) {
  console.error(`Missing codesigning identity: ${signingIdentity}`);
  process.exit(1);
}

run("pnpm", ["tauri", "build", "--bundles", "app,dmg"]);

const appPath = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  `${productName}.app`,
);
const dmgPath = latestDmg();

run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);

const notaryOutput = run(
  "xcrun",
  ["notarytool", "submit", dmgPath, ...authArgs, "--wait", "--timeout", "45m", "--output-format", "json"],
  { capture: true, redact: `notarytool submit "${dmgPath}" <credentials> --wait --timeout 45m --output-format json` },
);
process.stdout.write(notaryOutput);
const result = JSON.parse(notaryOutput);
if (result.status !== "Accepted") {
  console.error(`Notarization failed with status: ${result.status ?? "unknown"}`);
  process.exit(1);
}

run("xcrun", ["stapler", "staple", "-v", dmgPath]);
run("xcrun", ["stapler", "validate", "-v", dmgPath]);
run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath]);
run("shasum", ["-a", "256", dmgPath]);

console.log(`\nReady: ${dmgPath}`);
