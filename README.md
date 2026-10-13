<div align="center">

# Eilmer Lua for VS Code

**Hover docs, completions and error checking for Eilmer 5 (`lmr`) input scripts.**

[![Tests](https://img.shields.io/github/actions/workflow/status/huntsman33/Eilmer-Lua/tests.yml?branch=main&label=tests&logo=githubactions&logoColor=white)](https://github.com/huntsman33/Eilmer-Lua/actions/workflows/tests.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Eilmer 5](https://img.shields.io/badge/Eilmer-5%20(lmr)-orange)](https://github.com/gdtk-uq/gdtk)
[![VS Code](https://img.shields.io/badge/VS%20Code-extension-007ACC?logo=visualstudiocode&logoColor=white)](#install)

<img src="images/demo.gif" alt="Hover docs, completion and a quick fix in an Eilmer script" width="720">

</div>

---

## Features

| | |
| --- | --- |
| **Hover docs** | Docs for Eilmer classes, functions and `config.*` fields, pulled from the gdtk source, with a link to the defining file and line |
| **Completion** | Globals, methods, constructor keys (`StructuredGrid:new{` → `niv`, `psurface`), `config.` fields and valid option strings (`flux_calculator = "` → `ausmdv`, `hllc`) |
| **Error checking** | Catches the typos Eilmer silently ignores — see below |

### What it catches

| You wrote | Problem |
| --- | --- |
| `StructuredGrid:new{nvi=11}` | Unknown key — quick fix to `niv` |
| `config.max_tme = 1e-3` | Unknown field. Eilmer only prints a warning and ignores it, so your end time is never set |
| `config.gasdynamic_update_scheme = "rk3"` | Invalid option string |
| `Line.new{...}` | Should be `Line:new{...}` |
| `StructredGrid` | Misspelt Eilmer function or class |

## How it works

```
gdtk source ──gawk──┐
                    ├─ scripts/gen-eilmer-api.sh ──► data/eilmer-api.json ──► LuaCATS ---@meta file ──► sumneko
lmr (runtime) ──────┘     (introspect.lua runs inside `lmr custom-script`)          + extension diagnostics
```

`scripts/gen-eilmer-api.sh` combines two sources:

1. **Static scan (gawk)** of `src/{geom,gas,gasdyn,kinetics,nm,util,lmr}/**/*.d`:
   `luaL_newmetatable` / `lua_pushcfunction` + `lua_setfield` / `lua_setglobal` give the
   Lua-name → D-function map. Each D function's doc comment, its `checkAllowedNames(...)` key
   list, and its `"Expected X:new{...}"` usage string are extracted. `config` field comments
   come from `lmr/globalconfig.d`, and enum options from the `case "...":` lists in its `*_from_name()` functions.
2. **Runtime introspection** inside the real `lmr` Lua environment (`lmr custom-script`): it loads
   `prepgrids.lua`, `prepsim.lua`, `prep-chem` and `prep-kinetics`, and records exactly which
   globals exist in each stage. For Lua-defined functions it records the parameter names
   (`debug.getlocal`), source line (`debug.getinfo`), comment block and `checkAllowedNames` list.
   It also builds real `FlowState`/`GasState` objects to record their fields.

Runtime decides *what exists*; the static scan supplies docs. Run-time-only UDF globals
(`sampleFluidCell`, `blkId`, `setVtxVelocitiesByCorners`, …) are added from the static scan and
marked "run". `scripts/overrides.json` holds the few facts that can't be scanned (mostly return types,
e.g. `setGasModel` → `nsp, nmodes, GasModel`).

## Use

Install `dist/vscode-eilmer-*.vsix` (Extensions view → `…` → *Install from VSIX…*, or
`code --install-extension dist/vscode-eilmer-0.1.0.vsix`). Requires the
[sumneko Lua extension](https://marketplace.visualstudio.com/items?itemName=sumneko.lua), which VS Code installs
automatically as a dependency.

The first time a Lua file is opened, the extension adds its generated definitions folder to
`Lua.workspace.library` and sets `undefined-global`/`undefined-field` to Error. By default these go in
the open **workspace's** `.vscode/settings.json`, so other Lua projects are unaffected. Set
`eilmer.settingsTarget` to `global` to apply them everywhere, or `eilmer.strictUndefined` to `false`
to keep those diagnostics as warnings.

The bundled dictionary matches the gdtk revision it was generated from. Generating your own (below)
needs `bash`, `gawk` and a working `lmr`. That works on Linux and WSL; on macOS, install gawk first (`brew install gawk`).

After `git pull` + rebuild of gdtk, run **Eilmer: Regenerate API Dictionary from gdtk Source**
(the extension also offers this when it notices the gdtk revision has changed).

Settings: `eilmer.gdtkRepo`, `eilmer.gdtkInstall` (default `$DGD_REPO`, `$DGD`),
`eilmer.settingsTarget`, `eilmer.strictUndefined`, `eilmer.diagnostics.enable`, `eilmer.checkStaleness`.

## Develop

```bash
bash scripts/gen-eilmer-api.sh                 # rebuild data/eilmer-api.json (needs gawk + lmr)
EILMER_API_KEEP=1 bash scripts/gen-eilmer-api.sh  # keep the intermediate .tsv files
node test/run-tests.js [dirs...]               # unit tests + false-positive sweep over gdtk/examples/lmr
npm run package                                # build dist/*.vsix
```

## Limits

- D parameter *types* are heuristics, so they appear in field descriptions (`(Vector3)`) but are
  not enforced. Only exhaustive key lists (`checkAllowedNames`) produce unknown-key errors.
- Every Eilmer global is known in every Lua file. A prep-grid script will not be warned for using a
  prep-sim-only name. Hover shows which stages a name belongs to.
- Globals defined in a file you `dofile()` are only known to sumneko if that file is in the workspace.

## Licence

GPL-3.0-or-later; see [LICENSE](LICENSE). The bundled `data/eilmer-api.json` includes documentation
extracted from [gdtk](https://github.com/gdtk-uq/gdtk), which is also GPL v3.
