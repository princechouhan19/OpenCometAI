# Distribution strategy

Where the code lives, and what that does and does not protect.

## Protected by moving logic server side

- License generation and validation.
- Browser-agent planning and action prompts.

## Not protectable

- Content scripts, DOM action code, UI logic and message routing must run in the
  browser.
- Anything shipped in the extension package can eventually be read.

## Launch approach

1. Keep premium logic, prompt logic and provider keys on the backend.
2. Ship a bundled production build rather than the raw source tree.
3. Minify and obfuscate the bundle before uploading to the Chrome Web Store.
4. Disable source maps in the store package.
5. Gate agent API access by license key and rate limit.

## Next step

Add a build pipeline that bundles `src/` into `dist/`, minifies the JavaScript,
obfuscates the bundle, and packages only `dist/`, assets and `manifest.json`.

This is the same shape commercial extensions use: valuable logic server side,
then obfuscation for the client layer that cannot be hidden.
