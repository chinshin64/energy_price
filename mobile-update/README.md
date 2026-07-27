# Mobile update service

The service binds to `127.0.0.1:50082` and must be exposed through an existing HTTPS Nginx
virtual host. It contains no authentication secret and does not receive the mobile ingest token.

Publish an already signed APK with a manifest containing `packageName`, `versionName`,
`versionCode`, `sha256`, `size`, `apkFile`, and `abi: "arm64-v8a"`:

```bash
node publish.js /opt/data-for-didi-mobile-update/releases \
  ./information-auto-recognition-v2.3.1.apk \
  ./manifest-2.3.1.json
```

Publication copies the APK to a temporary same-filesystem name, renames it into place, and only
then atomically replaces `current.json`. Install the systemd and Nginx templates from `deploy/`
after adapting only OS user and virtual-host placement. TLS remains owned by the existing Nginx
server block.
