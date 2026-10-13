-- introspect.lua
-- Run by gen-eilmer-api.sh via `lmr custom-script`, i.e. inside the same Lua
-- environment that `lmr prep-grid` / `lmr prep-sim` give a user's input script.
-- Merges runtime facts (what actually exists) with the static scan of the D
-- sources (docs, allowed table keys) and writes the API dictionary as JSON.

local WORK = assert(os.getenv("EILMER_API_WORK"), "EILMER_API_WORK not set")
local OUT  = assert(os.getenv("EILMER_API_OUT"), "EILMER_API_OUT not set")
local INST = os.getenv("EILMER_API_INST")
local REPO = os.getenv("EILMER_API_REPO")

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
local ARRAY = {}  -- metatable marker so the encoder emits [] even when empty
local function arr(t) return setmetatable(t or {}, ARRAY) end

local function split(s, sep)
   local out = {}
   if s == nil or s == "" then return out end
   for piece in (s .. sep):gmatch("(.-)" .. sep:gsub("%p", "%%%0")) do out[#out + 1] = piece end
   return out
end

local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end

local function unescape(s) return (s:gsub("\\n", "\n"):gsub("\\\\", "\\")) end

local function tidyDoc(s)
   if s == nil then return nil end
   s = s:gsub("\n%s*\n%s*\n+", "\n\n"):gsub("^%s+", ""):gsub("%s+$", "")
   if s == "" then return nil end
   return s
end

local function readTSV(name, ncols)
   local rows = {}
   local f = assert(io.open(WORK .. "/" .. name, "r"))
   for line in f:lines() do
      local cols = split(line, "\t")
      for i = #cols + 1, ncols do cols[i] = "" end
      rows[#rows + 1] = cols
   end
   f:close()
   return rows
end

local fileCache = {}
local function fileLines(path)
   if fileCache[path] == nil then
      local f = io.open(path, "r")
      local lines = {}
      if f then for l in f:lines() do lines[#lines + 1] = l end; f:close() end
      fileCache[path] = lines
   end
   return fileCache[path]
end

-- JSON encoder: sorted keys (stable diffs), arrays via arr(), nan/inf -> null.
local function encode(v, indent)
   indent = indent or ""
   local t = type(v)
   if t == "nil" then return "null"
   elseif t == "boolean" then return tostring(v)
   elseif t == "number" then
      if v ~= v or v == math.huge or v == -math.huge then return "null" end
      if math.type(v) == "integer" then return tostring(v) end
      return string.format("%.17g", v)
   elseif t == "string" then
      return '"' .. v:gsub('[%c"\\]', function(c)
         local map = {['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t'}
         return map[c] or string.format("\\u%04x", c:byte())
      end) .. '"'
   elseif t == "table" then
      local inner = indent .. " "
      if getmetatable(v) == ARRAY then
         if #v == 0 then return "[]" end
         local parts = {}
         for i = 1, #v do parts[i] = inner .. encode(v[i], inner) end
         return "[\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "]"
      end
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = tostring(k) end
      table.sort(keys)
      if #keys == 0 then return "{}" end
      local parts = {}
      for i, k in ipairs(keys) do
         local val = v[k]; if val == nil then val = v[tonumber(k)] end
         parts[i] = inner .. encode(k) .. ": " .. encode(val, inner)
      end
      return "{\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "}"
   end
   return "null"
end

-- ---------------------------------------------------------------------------
-- Static-scan tables from gen-eilmer-api.sh
-- ---------------------------------------------------------------------------
local mtconst = {}
for _, r in ipairs(readTSV("mtconst.tsv", 2)) do mtconst[r[1]] = r[2] end
local function resolveName(x) return mtconst[x] or x end

-- dfuncs: name -> list of records (a name may appear in several files)
local dfuncs = {}
for _, r in ipairs(readTSV("dfuncs.tsv", 7)) do
   local rec = {name = r[1], file = r[2], line = tonumber(r[3]), allowed = split(r[4], ","),
                usage = r[5] ~= "" and unescape(r[5]) or nil, types = {}, doc = tidyDoc(unescape(r[7]))}
   for _, kv in ipairs(split(r[6], ",")) do
      local k, ty = kv:match("^([^:]+):(.+)$")
      if k then rec.types[k] = ty end
   end
   dfuncs[r[1]] = dfuncs[r[1]] or {}
   table.insert(dfuncs[r[1]], rec)
end
local function findDFunc(name, preferFile)
   local list = dfuncs[name]
   if not list then return nil end
   for _, rec in ipairs(list) do if rec.file == preferFile then return rec end end
   -- prefer lmr/ over other trees, otherwise the first found
   for _, rec in ipairs(list) do if rec.file:match("^lmr/") then return rec end end
   return list[1]
end

-- Registration rows. Rows on anonymous tables ("?") are attached to the
-- next `table` row in the same file, which names the global.
local dGlobals, dMethods, dTableValues, dClassReg = {}, {}, {}, {}
do
   local pending = {}
   for _, r in ipairs(readTSV("reg.tsv", 7)) do
      local kind, tbl, name, fn, file, line, regfn = r[1], resolveName(r[2]), resolveName(r[3]), r[4], r[5], tonumber(r[6]), r[7]
      local row = {kind = kind, tbl = tbl, name = name, fn = fn, file = file, line = line, regfn = regfn}
      if kind == "global" or kind == "value" then
         dGlobals[name] = dGlobals[name] or row
      elseif kind == "table" then
         for _, p in ipairs(pending) do p.tbl = name end
         for _, p in ipairs(pending) do
            local bucket = p.kind == "method" and dMethods or dTableValues
            bucket[name] = bucket[name] or {}
            bucket[name][p.name] = bucket[name][p.name] or p
         end
         pending = {}
         if tbl ~= "?" and tbl ~= name and dMethods[tbl] then dMethods[name] = dMethods[name] or dMethods[tbl] end
         dClassReg[name] = dClassReg[name] or row
      elseif tbl == "?" then
         pending[#pending + 1] = row
      else
         local bucket = kind == "method" and dMethods or dTableValues
         bucket[tbl] = bucket[tbl] or {}
         bucket[tbl][name] = bucket[tbl][name] or row
         dClassReg[tbl] = dClassReg[tbl] or row
      end
   end
end

-- Category (base class) for families of D-registered geometry objects.
local categoryByRegFn = {
   registerPaths = "Path", registerSurfaces = "ParametricSurface",
   registerVolumes = "ParametricVolume", registerUnivariateFunctions = "UnivariateFunction",
}

local configDoc = {}
for _, r in ipairs(readTSV("configdoc.tsv", 4)) do
   configDoc[r[1]] = {dtype = r[2], default = r[3], doc = tidyDoc(unescape(r[4]))}
end
local enums = {}
for _, r in ipairs(readTSV("enums.tsv", 3)) do
   enums[r[1]] = {options = split(r[2], ","), hyphens = r[3] == "1"}
end

-- ---------------------------------------------------------------------------
-- Runtime snapshots
-- ---------------------------------------------------------------------------
local stdNames = {}
for _, k in ipairs{"_G", "_VERSION", "assert", "collectgarbage", "coroutine", "debug", "dofile",
                   "error", "getmetatable", "io", "ipairs", "load", "loadfile", "math", "next", "os",
                   "package", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset",
                   "require", "select", "setmetatable", "string", "table", "tonumber", "tostring",
                   "type", "utf8", "xpcall", "warn", "arg"} do stdNames[k] = true end
-- Names that belong to this script or to the custom-script command itself.
local selfNames = {verbosity = true}

local function snapshot()
   local s = {}
   for k, v in pairs(_G) do
      if type(k) == "string" and not stdNames[k] and not selfNames[k] then s[k] = v end
   end
   return s
end

package.path = INST .. "/lib/?.lua;" .. package.path
local G0 = snapshot()  -- D-registered environment only
dofile(INST .. "/lib/prepgrids.lua")
local Ggrid = snapshot()
dofile(INST .. "/lib/prepsim.lua")
local Gsim = snapshot()

-- The chemistry preparation programs (used by `lmr prep-reactions` and
-- `lmr prep-energy-exchange`) are Lua scripts that define the functions used
-- in reaction/mechanism input files, then call main(). With no arguments
-- main() prints help and calls os.exit(); we intercept that and keep the
-- globals defined before it. Their internal driver functions are dropped.
local scriptInternals = {main = true, printHelp = true, buildVerboseLuaFile = true,
                         buildCompactNotationFile = true, odeStepToStr = true}
local function loadScriptStage(path)
   local before = snapshot()
   local realExit, realPrint = os.exit, print
   os.exit = function() error("eilmer-api: intercepted os.exit", 0) end
   print = function() end
   arg = {[0] = path}
   pcall(dofile, path)
   os.exit, print, arg = realExit, realPrint, nil
   local added = {}
   for k, v in pairs(snapshot()) do
      if before[k] ~= v and not scriptInternals[k] then added[k] = v end
   end
   return added
end
local Gchem = loadScriptStage(INST .. "/bin/prep-chem")
local Gkin = loadScriptStage(INST .. "/bin/prep-kinetics")

local stageTables = {{"grid", Ggrid}, {"sim", Gsim}, {"chem", Gchem}, {"kinetics", Gkin}}

-- reverse map: table value -> global name (for parent-class lookup)
local tableName = {}
for _, G in ipairs{Gsim, Ggrid, Gchem, Gkin} do
   for k, v in pairs(G) do if type(v) == "table" and not tableName[v] then tableName[v] = k end end
end

-- ---------------------------------------------------------------------------
-- Lua function description (source docs, params, allowed keys)
-- ---------------------------------------------------------------------------
-- Paths in the JSON are machine-independent: relative to the gdtk repo root
-- ("src/lmr/lua-modules/bc.lua"), or "$DGD/..." for files only in the install.
-- The extension resolves them to a local file or a GitHub URL.
local function repoPathFor(src)
   -- Map an installed file (lib/bc.lua, bin/prep-chem) back to its repo source.
   local base = src:match("([^/]+)$")
   local candidates = {base, (base:gsub("-", "_")) .. ".lua"}
   for _, dir in ipairs{"src/lmr/lua-modules/", "src/lib/", "src/gas/", "src/kinetics/", "src/geom/"} do
      for _, name in ipairs(candidates) do
         local f = io.open(REPO .. "/" .. dir .. name, "r")
         if f then f:close(); return dir .. name end
      end
   end
   if src:sub(1, #REPO + 1) == REPO .. "/" then return src:sub(#REPO + 2) end
   if src:sub(1, #INST + 1) == INST .. "/" then return "$DGD/" .. src:sub(#INST + 2) end
   return base
end

local function stripComment(l)
   local t = l:gsub("^%s*%-%-+%s?", "")
   if t:match("^%s*[-=*]+%s*$") or t:match("^%s*%-%-%-%-") then return nil end
   return t
end

local function describeLuaFunction(f)
   local info = debug.getinfo(f, "Su")
   if info.what ~= "Lua" or not info.source:match("^@") then return nil end
   local path = info.source:sub(2)
   local lines = fileLines(path)
   local d = {origin = "lua", file = repoPathFor(path), line = info.linedefined}
   -- parameters
   local params = arr()
   for i = 1, info.nparams do params[#params + 1] = debug.getlocal(f, i) end
   if info.isvararg then params[#params + 1] = "..." end
   d.call = (params[1] == "self") and ":" or "."
   if params[1] == "self" then table.remove(params, 1) end
   d.args = params
   -- docs: comment block directly above, plus comment lines directly below the header
   local above, below = {}, {}
   local i = info.linedefined - 1
   while i >= 1 and lines[i] and lines[i]:match("^%s*%-%-") do
      local t = stripComment(lines[i]); if t then table.insert(above, 1, t) end
      i = i - 1
   end
   i = info.linedefined + 1
   while lines[i] and lines[i]:match("^%s*%-%-") do
      local t = stripComment(lines[i]); if t then below[#below + 1] = t end
      i = i + 1
   end
   local docLines = {}
   for _, t in ipairs(above) do docLines[#docLines + 1] = t end
   for _, t in ipairs(below) do docLines[#docLines + 1] = t end
   d.doc = tidyDoc(table.concat(docLines, "\n"))
   d._docLines = docLines
   -- body analysis
   local body = table.concat(lines, "\n", info.linedefined, math.max(info.linedefined, info.lastlinedefined))
   local list = body:match("checkAllowedNames%s*%(%s*[%w_]+%s*,%s*(%b{})")
   if list then
      d.allowed = arr()
      for name in list:gmatch("[\"']([^\"']+)[\"']") do d.allowed[#d.allowed + 1] = name end
   else
      -- A thin wrapper that forwards its table to some X:new(o)/X.new(self, o)?
      d._delegate = body:match("([%a_][%w_]*)%s*:%s*new%s*%(%s*" .. (params[1] or "o") .. "%s*%)")
                 or body:match("([%a_][%w_]*)%s*%.%s*new%s*%(%s*self%s*,%s*" .. (params[1] or "o") .. "%s*%)")
   end
   d._stub = body:match("Do NOTHING") ~= nil
   return d
end

-- Per-key docs from comment blocks written as "-- key: description".
local function paramDocsFrom(docLines, allowed)
   local docs, isAllowed, cur = {}, {}, nil
   for _, k in ipairs(allowed) do isAllowed[k] = true end
   for _, l in ipairs(docLines or {}) do
      local k, rest = l:match("^%s*([%a_][%w_]*)%s*[:=%-]+%s*(.*)$")
      if k and isAllowed[k] then
         cur = k; docs[k] = rest
      elseif cur and l:match("^%s+%S") then
         docs[cur] = docs[cur] .. " " .. trim(l)
      else
         cur = nil
      end
   end
   return docs
end

local function paramsFromAllowed(allowed, types, docs)
   local out = arr()
   for _, k in ipairs(allowed or {}) do
      out[#out + 1] = {name = k, type = types and types[k] or nil, doc = docs and docs[k] or nil}
   end
   return out
end

-- ---------------------------------------------------------------------------
-- Describe each global
-- ---------------------------------------------------------------------------
local function describeCFunction(name, row, extra)
   local d = {origin = "D"}
   if row then
      local rec = findDFunc(row.fn, row.file)
      d.file = "src/" .. ((rec and rec.file) or row.file)
      d.line = (rec and rec.line) or row.line
      d.dfunc = row.fn
      if rec then
         d.doc = rec.doc
         d.usage = rec.usage
         d._types = rec.types
         if #rec.allowed > 0 then d.allowed = arr(rec.allowed) end
      end
   end
   for k, v in pairs(extra or {}) do d[k] = v end
   return d
end

local function valueType(v)
   local t = type(v)
   if t == "number" then return math.type(v) == "integer" and "integer" or "number" end
   return t
end

local function simpleValue(v)
   local t = type(v)
   if t == "number" or t == "string" or t == "boolean" then return v end
   return nil
end

-- A "settings table" is the config/NewtonKrylovGlobalConfig pattern:
-- empty proxy table whose metatable holds the real values plus __newindex.
local function isSettingsTable(t)
   if next(t) ~= nil then return false end
   local mt = getmetatable(t)
   return type(mt) == "table" and mt.__newindex ~= nil and mt.__index ~= nil
end

local function luaConfigComments(path)
   -- key -> trailing or preceding comment in a Lua settings file.
   local docs, pre = {}, {}
   for _, l in ipairs(fileLines(path)) do
      local key, rest = l:match("^%s*([%a_][%w_]*)%s*=(.*)$")
      if key then
         local trailing = rest:match("%-%-%s*(.-)%s*$")
         local d = trailing or (#pre > 0 and table.concat(pre, " ") or nil)
         if d and d ~= "" then docs[key] = d end
         pre = {}
      elseif l:match("^%s*%-%-") then
         local t = stripComment(l); if t and t ~= "" then pre[#pre + 1] = trim(t) end
      else
         pre = {}
      end
   end
   return docs
end

local function describeSettings(name, t)
   local mt = getmetatable(t)
   local d = {kind = "settings", origin = "lua", fields = {}}
   local src
   if type(mt.__newindex) == "function" then
      local info = debug.getinfo(mt.__newindex, "S")
      if info.source:match("^@") then src = info.source:sub(2); d.file = repoPathFor(src) end
   end
   local luaDocs = src and luaConfigComments(src) or {}
   for k, v in pairs(mt) do
      if type(k) == "string" and not k:match("^__") then
         local f = {type = valueType(v), default = simpleValue(v)}
         local cd = (name == "config") and configDoc[k] or nil
         if cd then f.dtype = cd.dtype end
         f.doc = (cd and cd.doc) or luaDocs[k]
         if name == "config" and enums[k] then
            f.options = arr(enums[k].options)
            f.hyphensNormalised = enums[k].hyphens or nil
         end
         d.fields[k] = f
      end
   end
   return d
end

local function collectMembers(t)
   -- own + inherited (via metatable __index chain) members of a Lua table
   local members, depth, cur, seen = {}, 0, t, {}
   while type(cur) == "table" and depth < 12 and not seen[cur] do
      seen[cur] = true
      for k, v in pairs(cur) do
         if type(k) == "string" and members[k] == nil then members[k] = {value = v, owner = cur} end
      end
      local mt = getmetatable(cur)
      cur = type(mt) == "table" and (type(mt.__index) == "table" and mt.__index or mt) or nil
      if cur == t then break end
      depth = depth + 1
   end
   return members
end

local function describeTable(name, t)
   if isSettingsTable(t) then return describeSettings(name, t) end
   local d = {fields = {}, methods = {}}
   local creg = dClassReg[name]
   local dm = dMethods[name] or {}
   local members = collectMembers(t)
   for k, m in pairs(members) do
      local v = m.value
      if k:match("^__") and k ~= "__call" then
         -- skip metamethods
      elseif type(v) == "function" then
         local md = describeLuaFunction(v)
         if not md then
            md = describeCFunction(k, dm[k], {call = ":"})
         end
         if m.owner ~= t and tableName[m.owner] then md.inherited = tableName[m.owner] end
         d.methods[k] = md
      elseif type(v) ~= "table" and type(v) ~= "userdata" then
         d.fields[k] = {type = valueType(v), value = simpleValue(v)}
      end
   end
   if d.methods.new then
      d.kind = "class"
      -- parent: the metatable (Lua-side classes) or the registration family (D classes)
      local mt = getmetatable(t)
      if type(mt) == "table" and mt ~= t and tableName[mt] and tableName[mt] ~= name then
         d.parent = tableName[mt]
      elseif creg and categoryByRegFn[creg.regfn] and categoryByRegFn[creg.regfn] ~= name then
         d.parent = categoryByRegFn[creg.regfn]
      end
   else
      d.kind = (next(d.methods) ~= nil) and "module" or "table"
      -- Functions in a module table (e.g. gasflow.normal_shock) are called with '.'.
      for _, md in pairs(d.methods) do
         if md.origin == "D" then md.call = "." end
      end
   end
   if creg then
      d.origin = "D"; d.file = "src/" .. creg.file; d.line = creg.line
   end
   if next(d.methods) == nil then d.methods = nil end
   if next(d.fields) == nil then d.fields = nil end
   return d
end

local function describe(name, v)
   local t = type(v)
   if t == "function" then
      local d = describeLuaFunction(v) or describeCFunction(name, dGlobals[name])
      d.kind = "function"
      return d
   elseif t == "table" then
      return describeTable(name, v)
   elseif t == "userdata" then
      return {kind = "value", type = "userdata"}
   else
      return {kind = "value", type = valueType(v), value = simpleValue(v)}
   end
end

-- ---------------------------------------------------------------------------
-- Assemble
-- ---------------------------------------------------------------------------
local globals = {}
local allNames = {}
for _, st in ipairs(stageTables) do
   for k in pairs(st[2]) do allNames[k] = true end
end
local stageLabel = {grid = "prep-grid", sim = "prep-sim", chem = "prep-reactions", kinetics = "prep-energy-exchange"}

for name in pairs(allNames) do
   -- Describe the value seen in each stage; prefer a non-stub description
   -- (e.g. registerFluidGrid is a no-op in prep-sim, makeFluidBlocks in prep-grid).
   local d, stubs, stages = nil, {}, arr()
   local lastValue, differs = nil, false
   for _, st in ipairs(stageTables) do
      local v = st[2][name]
      if v ~= nil then
         stages[#stages + 1] = st[1]
         if lastValue ~= nil and v ~= lastValue then differs = true end
         lastValue = v
         local ds = describe(name, v)
         if ds._stub then stubs[#stubs + 1] = st[1] end
         if d == nil or (d._stub and not ds._stub) then d = ds end
      end
   end
   if differs and #stubs > 0 then
      d.stageNotes = {}
      for _, s in ipairs(stubs) do d.stageNotes[s] = "Has no effect during " .. stageLabel[s] .. "." end
   end
   d.stages = stages
   if G0[name] ~= nil then d.builtin = true end  -- registered from D before any prep*.lua
   if name:match("^_") then d.internal = true end
   globals[name] = d
end

-- Globals that only exist at run time, inside user-defined functions (UDFs:
-- boundary conditions, source terms, grid motion, supervisors). These are
-- registered by D code in lmr/ and so only the static scan can see them.
for name, row in pairs(dGlobals) do
   if globals[name] == nil and name:match("^[%a_][%w_]*$") and row.file:match("^lmr/")
      and not row.file:match("^lmr/commands/") then
      local d
      if row.kind == "global" then
         d = describeCFunction(name, row); d.kind = "function"; d.call = "."
      else
         d = {kind = "value", type = (row.fn == "integer" or row.fn == "number") and "number" or row.fn,
              origin = "D", file = "src/" .. row.file, line = row.line}
      end
      d.stages = arr{"run"}
      d.stageNotes = {run = "Only available at run time, in user-defined Lua functions (UDFs)."}
      globals[name] = d
   end
end

-- Fields of table "instances" built in D (e.g. GasState).
for _, r in ipairs(readTSV("instfields.tsv", 3)) do
   local cls, field, ty = r[1], r[2], r[3]
   local g = globals[cls]
   if g then
      g.instanceFields = g.instanceFields or {}
      g.instanceFields[field] = {type = ty}
   end
end

-- Second pass: resolve table-argument parameters (delegation, per-key docs).
local function finishCallable(d)
   if d.allowed == nil and d._delegate then
      local target = globals[d._delegate]
      local tm = target and target.methods and target.methods.new
      if tm and tm.allowed then
         d.allowed = tm.allowed; d._types = tm._types; d._docLines2 = tm._docLines
         d.delegatesTo = d._delegate .. ":new"
      end
   end
   if d.allowed then
      local docs = paramDocsFrom(d._docLines, d.allowed)
      for k, v in pairs(paramDocsFrom(d._docLines2, d.allowed)) do docs[k] = docs[k] or v end
      d.params = paramsFromAllowed(d.allowed, d._types, docs)
   elseif d._types and next(d._types) then
      -- Keys seen being read from the table, but no checkAllowedNames():
      -- useful for completion, but not an exhaustive list (paramsOpen).
      local keys = {}
      for k in pairs(d._types) do keys[#keys + 1] = k end
      table.sort(keys)
      d.params = paramsFromAllowed(keys, d._types, nil)
      d.paramsOpen = true
   end
   d.allowed = nil
   d._delegate = nil; d._types = nil; d._docLines = nil; d._docLines2 = nil; d._stub = nil
end
-- Plain functions first, so that wrappers delegating to X:new still see X's raw allowed names.
for _, d in pairs(globals) do
   if d.kind == "function" then finishCallable(d) end
end
for _, d in pairs(globals) do
   if d.methods then for _, m in pairs(d.methods) do finishCallable(m) end end
   d._stub = nil
end

-- Curated facts the scan cannot infer (return types etc.), from overrides.json.
do
   local f = io.open(WORK .. "/overrides.json", "r")
   local text = f and f:read("a") or "{}"
   if f then f:close() end
   local overrides = require('json').parse(text)
   for key, ov in pairs(overrides) do
      if not key:match("^_") then
         local cls, method = key:match("^([%w_]+):([%w_]+)$")
         local target = cls and globals[cls] and globals[cls].methods and globals[cls].methods[method]
                        or (not cls and globals[key])
         if target then
            for k, v in pairs(ov) do
               if k == "returns" then setmetatable(v, ARRAY) end
               target[k] = v
            end
         else
            io.stderr:write("introspect: override target not found: " .. key .. "\n")
         end
      end
   end
end

-- Instance fields from real objects, built with the ideal-air model that
-- gen-eilmer-api.sh prepared. Done last: setGasModel() changes global state.
do
   local gasFile = WORK .. "/ideal-air.gas"
   local fh = io.open(gasFile, "r")
   if fh then
      fh:close()
      local function record(cls, obj)
         if type(obj) ~= "table" or not globals[cls] then return end
         local g = globals[cls]
         g.instanceFields = g.instanceFields or {}
         for k, v in pairs(obj) do
            if type(k) == "string" and not k:match("^_") and not (g.methods and g.methods[k]) then
               g.instanceFields[k] = g.instanceFields[k] or {type = valueType(v)}
            end
         end
      end
      local ok, err = pcall(function()
         local _, _, gm = setGasModel(gasFile)
         record("FlowState", FlowState:new{p = 1.0e5, T = 300.0})
         record("GasState", GasState:new{gm})
      end)
      if not ok then io.stderr:write("introspect: instance probe failed: " .. tostring(err) .. "\n") end
   end
end

local result = {
   meta = {
      generator = "gen-eilmer-api.sh",
      generated = os.date("!%Y-%m-%dT%H:%M:%SZ"),
      gdtkRevision = os.getenv("EILMER_API_REV"),
      lmrRevision = os.getenv("EILMER_API_LMRREV"),
      luaVersion = _VERSION,
   },
   globals = globals,
}

local f = assert(io.open(OUT, "w"))
f:write(encode(result), "\n")
f:close()

local counts = {}
for _, d in pairs(globals) do counts[d.kind] = (counts[d.kind] or 0) + 1 end
local parts = {}
for k, n in pairs(counts) do parts[#parts + 1] = k .. "=" .. n end
table.sort(parts)
print("introspect: " .. table.concat(parts, " "))
