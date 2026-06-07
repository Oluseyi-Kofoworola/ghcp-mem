# Enterprise Guide

## Recommended settings

```json
{
  "baton.enterpriseMode": true,
  "baton.captureTerminalCommands": false,
  "baton.captureCodeSnippets": false,
  "baton.allowMcpWriteAccess": false,
  "baton.allowTeamExport": false,
  "baton.previewBeforePersist": true
}
```

## Policy options

- Use `baton.policySource` for centrally managed redaction rules.
- Prefer workspace settings for team-wide defaults.
- Use the memory audit view before sharing or exporting context.

## Operational guidance

- Disable terminal capture on regulated machines.
- Keep exports redacted and review them before distribution.
- Use purge commands to remove stale or incorrect memories quickly.
