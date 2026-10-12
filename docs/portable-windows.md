# Windows portable directory

This experimental Windows x64 distribution includes REA, its production Node
dependencies, the Windows native authority module, and Node.js. It does not
include npm. Copy the complete directory to its final location; no package
manager or download is required to start the included CLI or MCP server.

Run from PowerShell:

```powershell
.\rea.cmd --help
.\rea.cmd setup --client codex --dry-run --json
```

Review the setup plan before applying it with `setup --client codex --yes`.
Setup changes the selected client's configuration and installs REA's skill.
Registrations use the absolute paths of this directory's Node and REA entry
point. If you move the directory later, rerun setup from the new location and
restart the client. Moving a running server is not supported.

External tools such as Ghidra, Java, Hopper, browsers, and optional analysis
toolchains are not included. Prepare the tools needed for your task separately
before taking the machine offline. The portable directory does not make online
analysis, provider downloads, or `rea update` work without a network. Replace
it with a separately prepared directory to update offline.

The `runtime/LICENSE` file contains Node.js's license notices. REA and dependency
notices remain with their files under `app`. `portable.json` records the runtime,
dependency versions, and SHA-256 of every other output file. It is an inventory,
not a signature or a claim that every optional provider has been verified.

## Prepare a directory on a build machine

Use Windows x64, the pinned development toolchain, and a clean locked dependency
installation. Build REA following CONTRIBUTING.md. Prepare the Windows native
artifact using the existing Windows native build lane. Obtain and verify the
official Node.js Windows x64 archive for the version in `.nvmrc`, then extract it.
The builder consumes that local distribution and does not download Node.

```powershell
npm ci
npm run build:cached
npm run package:portable:windows -- --node-directory C:\build\node-v24.18.0-win-x64 --output-directory C:\build\rea-portable
```

The output directory must not already exist. A failed build leaves its partial
directory for inspection and does not write `portable.json`. Archive the entire
completed directory with your preferred ZIP tool, including `app/node_modules`.
Extract it at another path and verify your required workflows before archiving
or deploying it. npm and the build toolchain are needed only on the preparation
machine. This initial packaging lane targets Windows x64; it does not produce
Linux, macOS, or Windows ARM64 packages.

From the source checkout, verify an extracted directory with:

```powershell
npm run verify:portable:windows -- --directory C:\relocated\rea-portable
```

This checks the file inventory, the actual command launcher, isolated setup and
uninstall, and matching CLI/MCP static JavaScript analysis. The registered MCP
command must point to the included Node and REA entry point. Children use an
isolated user directory, with no npm or system Node on PATH. A Node preload
rejects socket connections; this is not an OS-level network sandbox. Optional
external providers and a live agent connection remain separate checks.
