# Didi browser signer runtime

This directory contains the two mini-program runtime bundles consumed by
`backend/services/browser-signer.js`:

- `APPAPPAPP/app-service.js`
- `_wsgsig_/wsgsig/app-service.js`

The service loads these files from this repository by default. Deployments may
override either path with `BROWSER_SIGNER_DIDI_MAIN_PATH` and
`BROWSER_SIGNER_DIDI_WSGSIG_PATH`.

SHA-256 checksums:

```text
43478b8288602b3749f045e0456f88ff8982b21b166378ea1112ead0c6a61d02  APPAPPAPP/app-service.js
295b469e45126b24b5a10eb675b92c2cb4840f2d2cd2d610891d420997d89841  _wsgsig_/wsgsig/app-service.js
```

Only use this runtime in an authorized test environment. HAR captures,
credentials, session tokens, request corpora, databases, and generated output
are intentionally excluded.
