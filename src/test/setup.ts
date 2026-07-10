// Vitest global setup for the test suite.
//
// Registered via `test.setupFiles` in vitest.config.ts so it runs before
// every test file. Adds React Testing Library's `cleanup()` after each test
// — without this, DOM from prior renders accumulates in `document.body`
// and `screen` queries return duplicate matches ("Multiple elements found").
// Vitest doesn't wire RTL's auto-cleanup by default the way Jest does.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
