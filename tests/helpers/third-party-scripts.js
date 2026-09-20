import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared rule for "eager third-party <script src> tags need SRI", used by
// tests/routes.smoke.test.js (real generated pages) and
// tests/adsense-foundation.test.js (negative controls).
//
// WHY ONE EXCEPTION EXISTS: every pinned cdnjs library carries a
// Subresource Integrity hash. Google's AdSense loader (adsbygoogle.js) is a
// Google-managed, unversioned, frequently updated script - a fixed SRI hash
// would break ads the first time Google updates it, so it cannot be treated
// like a static versioned library. The exception below is deliberately
// narrow so SRI stays enforced for everything else:
//   - only the EXACT approved URL (including our publisher id),
//   - only on the AdSense-enabled pages: the homepage and the generated tool pages
//     (never privacy-policy.html or 404.html),
//   - only when it is async and cross-origin anonymous,
//   - and it must NOT carry an integrity attribute (if it ever did, the
//     normal SRI rule would apply to it like any other script).
// Any other Google URL, another publisher id, another page, or any other
// third-party script is still held to the SRI rule.

const require = createRequire(import.meta.url);
const adsense = require("../../build/adsense-config.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (file) => JSON.parse(readFileSync(resolve(ROOT, file), "utf8"));
const toolFiles = [...readJson("seo/tools-registry.json").tools, ...readJson("seo/additional-tools.json").tools]
  .filter((tool) => tool.status !== "planned")
  .map((tool) => tool.file);
// The pages that carry the AdSense loader: the homepage + every generated tool page.
export const AD_ENABLED_FILES = ["index.html", ...toolFiles];

export function scriptTags(html) {
  const out = [];
  const re = /<script\s+([^>]*\bsrc="([^"]+)"[^>]*)><\/script>/g;
  let match;
  while ((match = re.exec(html))) out.push({ attributes: match[1], src: match[2] });
  return out;
}

export function externalScriptTags(html) {
  return scriptTags(html).filter((tag) => /^https?:\/\//.test(tag.src));
}

export function isApprovedGoogleManagedScript(file, tag) {
  return AD_ENABLED_FILES.includes(file)
    && tag.src === adsense.ADSENSE_SCRIPT_SRC
    && /\basync\b/.test(tag.attributes)
    && tag.attributes.includes('crossorigin="anonymous"')
    && !/\bintegrity=/.test(tag.attributes);
}

// Returns a description of every external script that breaks the rule.
export function findUnprotectedThirdPartyScripts(file, html) {
  const problems = [];
  for (const tag of externalScriptTags(html)) {
    if (isApprovedGoogleManagedScript(file, tag)) continue;
    if (!/\bintegrity="sha384-[^"]+"/.test(tag.attributes)) problems.push(file + ": " + tag.src + " has no SRI");
    else if (!tag.attributes.includes('crossorigin="anonymous"')) problems.push(file + ": " + tag.src + " is missing crossorigin=anonymous");
  }
  return problems;
}
