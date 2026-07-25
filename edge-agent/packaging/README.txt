Blue Team Edge Agent distribution

1. Copy edge-agent.env.example to edge-agent.env.
2. Set EDGE_SERVER_URL and EDGE_ENROLLMENT_TOKEN.
3. macOS: run run-macos.command. Windows: run run-windows.ps1.
4. The first registration creates a per-node session token in the local data directory.

The internal test executables and APK are unsigned development artifacts. Verify SHA256SUMS
before installation and sign them with the deployment certificate before production rollout.

The Agent executes only built-in allowlisted actions. It reports OS-visible device properties
and local salted hashes. It does not read or change WeChat internal fingerprints, hardware
serial numbers, MAC addresses, Android ID, or other raw stable device identifiers.
