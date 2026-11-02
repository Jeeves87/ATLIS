# ATLIS Forge bridge

A small Java program that runs [Forge](https://github.com/Card-Forge/forge)'s
Magic: The Gathering rules engine headless, so ATLIS can host Commander games
against it.

## License

This directory is licensed under the **GNU General Public License, version 3 or
later** (see [LICENSE](LICENSE)), separately from the rest of ATLIS.

The bridge is compiled against Forge's classes and runs inside the same JVM as
Forge, which is itself GPL-3.0, so the bridge is distributed under the GPL too.

## How it stays separate from ATLIS

ATLIS never links against the bridge or Forge. It starts the bridge as its own
process:

```
java -cp atlis-forge-bridge-<stamp>.jar;forge-gui-desktop-<ver>-jar-with-dependencies.jar atlis.bridge.Main
```

and the two talk only through JSON lines over stdin/stdout (see
`src/atlis/bridge/Protocol.java`). Nothing in here imports ATLIS code, and
nothing in ATLIS imports this code. Keep it that way: a change that needs to
share code across the boundary should become a new protocol message instead.

## Contents

| Path | What it is |
|---|---|
| `src/atlis/bridge/` | The bridge: game setup, the headless GUI Forge drives, state snapshots, the protocol. |
| `build.ps1` | Compiles the bridge against an installed Forge's desktop jar into `build/`. |
| `test/` | Node scripts that drive the bridge over the protocol: scenario tests and deck audits. |
| `tools/` | Dev utilities for reading Forge's class hierarchy. |

`build/` and `logs/` are generated and not checked in.

## Building

Needs a Temurin JDK 17+ and an installed copy of Forge.

```
powershell -File build.ps1 -Forge C:\Forge
```
