# Blue Team Desktop Edge Agent

The desktop Agent enrolls a macOS or Windows computer with the main Blue Team
server, sends heartbeats, leases allowlisted tasks, and reports results.

Supported task capabilities:

- `system.status`
- `blue-team.health`
- `desktop.wechat.status`
- `desktop.wechat.workflow`
- `desktop.wechat.basic-check`

The Agent does not expose arbitrary shell execution. Its device profile contains
OS-visible system properties and locally salted hashes only. It does not read or
modify WeChat internal fingerprints, hardware serial numbers, MAC addresses, or
other raw stable identifiers.

Configure the environment variables from `.env.example`, then run:

```text
npm install
npm test
npm run package:all
```

Runtime state and the per-node session token are stored outside the executable
under `EDGE_DATA_DIR` or `~/.blue-team-edge-agent`.

`--print-profile` prints the exact privacy-filtered profile and installation
fingerprint that this Agent would register, without contacting the server.

Ready-to-run platform archives are assembled by `scripts/package-edge-agents.sh`.
