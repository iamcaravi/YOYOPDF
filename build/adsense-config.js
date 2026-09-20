"use strict";

/* Single source of truth for the Google AdSense foundation (V1).
   Consumed by build/generate-landing.js (renders the homepage tag),
   build/verify-dist.js (verifies the built artifact) and the tests, so the
   publisher id / script URL / ads.txt line can never drift apart.

   SCOPE: the loader script is emitted on the homepage and every tool page (see
   renderAdSenseBlock() in build/generate-landing.js). It is not on 404.html or the
   privacy page, and no ad containers/units exist yet (no real ad-slot ID). The strict
   nonce CSP that lets it execute is applied by netlify/edge-functions/csp-nonce.js. */

const PUBLISHER_ID = "ca-pub-6665490745490381";
const PUBLISHER_SUFFIX = PUBLISHER_ID.replace(/^ca-/, ""); // ads.txt uses "pub-..." (no "ca-")

const ADSENSE_SCRIPT_SRC =
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + PUBLISHER_ID;

// Exactly the snippet Google supplied. It is a Google-managed, unversioned
// script, so - unlike the pinned cdnjs libraries - it cannot carry a
// Subresource Integrity hash; see the explicit, narrow exception in
// tests/routes.smoke.test.js and build/verify-dist.js.
const ADSENSE_SCRIPT_TAG =
  '<script async src="' + ADSENSE_SCRIPT_SRC + '"\n     crossorigin="anonymous"></script>';

// Official Google ads.txt line format for AdSense (DIRECT relationship).
const ADS_TXT_LINE = "google.com, " + PUBLISHER_SUFFIX + ", DIRECT, f08c47fec0942fa0";

module.exports = {
  PUBLISHER_ID,
  PUBLISHER_SUFFIX,
  ADSENSE_SCRIPT_SRC,
  ADSENSE_SCRIPT_TAG,
  ADS_TXT_LINE,
};
