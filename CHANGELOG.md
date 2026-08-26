# Changelog

## 1.0.0

First stable release. The plugin API and the on-disk format are settled: the
limits file is at `version: 2`, and older files are migrated on read rather than
discarded.

- Tests for limits-file path resolution and for migration from the pre-1.0
  location and schema, run on Node 20 and 22 across Linux and macOS in CI.
- No functional changes from 0.1.0.

## 0.1.0

Initial release: per-session spend limits, warning toasts, sidebar readout,
`/budget` slash command, and resume-after-limit via the prompt box.
