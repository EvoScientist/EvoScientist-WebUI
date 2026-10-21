<!-- Fill this out before submitting. New features / changes require peer review + manual testing before merge. -->

## What & why

<!-- What does this PR change, and why? -->

## Manual testing

> Must be tested against a real backend (`EvoSci deploy`, port 6174) — a green build is not enough.

- [ ] `npm run lint && npm run format:check && npm run build` all green
- [ ] Started the backend → configured the Deployment URL → chat works
- [ ] The feature(s) touched here were verified to work (Workspace / Skills / Memory / theme / chat …)
- [ ] Significant changes re-tested against the production build (`npm run build && npm start`; dev and standalone behave differently)

### Test steps / screenshots

<!-- How you tested it; attach screenshots or a screen recording. -->

## Checklist

- [ ] Self-tested, no obvious regressions
- [ ] Requested at least one teammate for **peer review**

---

> Merging ≠ shipping: releases are handled solely by the maintainer. A published release reaches users without a core release: EvoScientist v0.3.6+ picks up the newest version in its supported range (v0.3.6: `>=0.3,<0.4`; v0.3.7+: `>=0.3,<0.5`), and older versions run `@latest`.
