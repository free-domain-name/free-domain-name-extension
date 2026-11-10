/**
 * Cross-browser extension API.
 *
 * Firefox exposes the promise-based `browser` namespace. Chrome exposes
 * `chrome`, whose MV3 methods also return promises. Both expose the same
 * surface for the APIs used here, so a thin alias keeps the code shared.
 *
 * The lookup uses `globalThis` so pure modules can still be imported by unit
 * tests that do not provide an extension runtime.
 */
const globalScope = globalThis as unknown as {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

export const api = (globalScope.browser ?? globalScope.chrome) as typeof chrome;
