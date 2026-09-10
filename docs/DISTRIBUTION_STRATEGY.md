# Distribution Strategy

## What is now protected better

- License generation and validation now live on the backend.
- Browser-agent planning/action prompts now live on the website backend.
- The extension no longer needs to ship the strongest browser-agent system prompt.

## What still cannot be hidden fully

- Content scripts, DOM action code, UI logic, and message routing must still run in the browser.
- Anything shipped in the extension package can still be inspected eventually.

## Practical launch strategy

1. Keep premium logic, prompt logic, and provider API keys on the backend.
2. Ship the extension as a bundled production build instead of raw source files.
3. Minify and obfuscate the built bundle before uploading to the Chrome Web Store.
4. Disable source maps for the store package.
5. Gate browser-agent API access by active license key and rate limits.

## Best next implementation step

Add a build pipeline that:

- bundles `src/` into `dist/`
- minifies all JavaScript
- obfuscates the final bundle
- packages only `dist/`, assets, and `manifest.json`

This is the same broad pattern used by commercial extensions: keep the valuable logic server-side, then obfuscate the unavoidable client-side layer.
