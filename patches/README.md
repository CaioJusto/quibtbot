# Dependency security patches

`image-size@1.2.1.patch` rejects invalid ICNS entries and ISO media boxes whose
declared size cannot advance the parser. It mitigates GHSA-w3rx-r6r6-pgpr and
GHSA-5p2g-fcmc-qvqq while Metro (and therefore the pinned Expo SDK) has no
upstream release marked as fixed. The matching audit exceptions must be removed
when Expo/Metro adopts a patched `image-size` release.

`packages/testkit/src/dependency-hardening.test.ts` executes both malicious
zero-length cases in a subprocess with a timeout so a regression fails safely.
