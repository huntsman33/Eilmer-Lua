#!/usr/bin/env bash
# gen-eilmer-api.sh -- build a JSON dictionary of the Eilmer 5 (lmr) Lua scripting API.
#
# Two sources of truth are combined:
#   1. Static scan of the gdtk source tree (gawk):
#        - D bindings: which D function implements each Lua global / method,
#          its doc comment, allowed table keys (checkAllowedNames), usage strings,
#          and rough parameter types.
#        - globalconfig.d: per-field comments and enum options for config.* settings.
#   2. Runtime introspection inside the installed `lmr` (lmr custom-script):
#        - exactly which globals exist after prepgrids.lua and prepsim.lua load,
#        - Lua-side functions' source location, parameter names and doc comments.
#   Runtime is authoritative for *what exists*; the static scan supplies docs.
#
# Usage:
#   gen-eilmer-api.sh [-r GDTK_REPO] [-i GDTK_INSTALL] [-o OUTPUT.json]
# Defaults: $DGD_REPO, $DGD, ../data/eilmer-api.json (relative to this script).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${DGD_REPO:-$HOME/gdtk}"
inst="${DGD:-$HOME/gdtkinst}"
out="$script_dir/../data/eilmer-api.json"

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while getopts "r:i:o:h" opt; do
    case "$opt" in
        r) repo="$OPTARG" ;;
        i) inst="$OPTARG" ;;
        o) out="$OPTARG" ;;
        h) usage 0 ;;
        *) usage 1 ;;
    esac
done

die() { echo "gen-eilmer-api: $*" >&2; exit 1; }
[[ -d "$repo/src/lmr" ]] || die "gdtk repo not found at '$repo' (set DGD_REPO or use -r)"
[[ -f "$inst/lib/prepgrids.lua" ]] || die "gdtk install not found at '$inst' (set DGD or use -i)"
lmr_bin="$inst/bin/lmr"
[[ -x "$lmr_bin" ]] || lmr_bin="$(command -v lmr || true)"
[[ -x "$lmr_bin" ]] || die "cannot find the lmr executable"
command -v gawk >/dev/null || die "gawk is required"

work="$(mktemp -d "${TMPDIR:-/tmp}/eilmer-api.XXXXXX")"
# Set EILMER_API_KEEP=1 to keep the intermediate .tsv files for debugging.
if [[ -n "${EILMER_API_KEEP:-}" ]]; then
    echo "gen-eilmer-api: keeping intermediate files in $work" >&2
else
    trap 'rm -rf "$work"' EXIT
fi
src="$repo/src"

# Files that feed the prep-stage Lua environment (see lmr/lua_helper.d).
# Old Eilmer 4 sources (src/eilmer), demos and retired code are skipped.
mapfile -t dfiles < <(
    find "$src/geom" "$src/gas" "$src/gasdyn" "$src/kinetics" "$src/nm" "$src/util" "$src/lmr" \
         -name '*.d' ! -name '*_demo.d' ! -path '*/retired/*' -print0 2>/dev/null \
    | xargs -0 grep -l -E 'lua_setglobal|lua_setfield|extern *\(C\)' | sort
)
echo "gen-eilmer-api: scanning ${#dfiles[@]} D source files under $src" >&2

# ---------------------------------------------------------------------------
# 1a. Metatable-name constants:  immutable string LineMT = "Line";
# ---------------------------------------------------------------------------
gawk '
match($0, /(immutable|enum|static|const)?[ \t]*string[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*"([A-Za-z_][A-Za-z0-9_]*)"[ \t]*;/, m) {
    if (m[2] ~ /MT$|Name$|Type$/) print m[2] "\t" m[3]
}' "${dfiles[@]}" | sort -u > "$work/mtconst.tsv"

# ---------------------------------------------------------------------------
# 1b. Registration scan: which Lua name is bound to which D function.
#   reg.tsv: kind  table  luaName  dFunc  file  line  registerFn
#   kind = method | global | table | value | tablevalue
# ---------------------------------------------------------------------------
gawk -v SRC="$src/" '
function strip_name(x,   y) {
    y = x
    gsub(/^[ \t]+|[ \t]+$/, "", y)
    gsub(/\.toStringz(\(\))?$/, "", y)
    if (match(y, /^toStringz\((.*)\)$/, mm)) y = mm[1]
    gsub(/^"|"$/, "", y)
    return y
}
function emit(kind, tbl, name, fn) {
    f = FILENAME; sub(SRC, "", f)
    print kind "\t" tbl "\t" name "\t" fn "\t" f "\t" FNR "\t" regfn
}
FNR == 1 { tbl = ""; pend = ""; regfn = "" }
/^[ \t]*(void|int)[ \t]+register[A-Za-z0-9_]*[ \t]*\(/ {
    match($0, /register[A-Za-z0-9_]*/); regfn = substr($0, RSTART, RLENGTH)
}
{
    line = $0
    sub(/\/\/.*$/, "", line)
    n = split(line, stmts, ";")
    for (i = 1; i <= n; i++) {
        s = stmts[i]
        if (match(s, /luaL_newmetatable\([^,]+,[ \t]*([^)]+(\(\))?)\)/, m)) {
            tbl = strip_name(m[1]); pend = ""
        } else if (s ~ /lua_newtable\(/) {
            tbl = "?"; pend = ""
        } else if (match(s, /lua_pushcfunction\([^,]+,[ \t]*&?[ \t]*([A-Za-z_][A-Za-z0-9_]*)/, m)) {
            pend = "fn:" m[1]
        } else if (match(s, /lua_push(number|integer|string|boolean)\(/, m)) {
            pend = "val:" m[1]
        } else if (match(s, /lua_setfield\([^,]+,[ \t]*-2[ \t]*,[ \t]*"([^"]+)"/, m)) {
            if (tbl != "" && pend ~ /^fn:/)  emit("method", tbl, m[1], substr(pend, 4))
            if (tbl != "" && pend ~ /^val:/) emit("tablevalue", tbl, m[1], substr(pend, 5))
            pend = ""
        } else if (match(s, /push_array_to_Lua\([^,]+,[^,]+,[ \t]*"([A-Za-z_][A-Za-z0-9_]*)"/, m)) {
            emit("value", "", m[1], "table")
        } else if (match(s, /lua_setglobal\([^,]+,[ \t]*(.+)\)[ \t]*$/, m)) {
            name = strip_name(m[1])
            if (pend ~ /^fn:/)       emit("global", "", name, substr(pend, 4))
            else if (pend ~ /^val:/) emit("value", "", name, substr(pend, 5))
            else if (tbl != "")      emit("table", tbl, name, "")
            tbl = ""; pend = ""
        }
    }
}' "${dfiles[@]}" > "$work/reg.tsv"

# ---------------------------------------------------------------------------
# 1c. D function details: doc comment, allowed keys, usage, parameter types.
#   dfuncs.tsv: name  file  line  allowedNames  usage  paramTypes  doc
#   (doc has newlines encoded as \n; tabs removed)
# ---------------------------------------------------------------------------
gawk -v SRC="$src/" '
function clean(s) { gsub(/\t/, " ", s); gsub(/\\/, "\\\\", s); return s }
function banner(t) { return t ~ /^[ \t]*[-=*]{3,}/ || t ~ /[-=]{6,}[ \t]*$/ }
function addtype(k, t) { if (!(k in seen_t)) { seen_t[k] = 1; types = types (types == "" ? "" : ",") k ":" t } }
function guess(s) {
    if (s ~ /toVector3|checkVector3|getVector3/)                         return "Vector3"
    if (s ~ /checkPath|toPath/)                                          return "Path"
    if (s ~ /checkSurface|toSurface|checkParametricSurface/)             return "ParametricSurface"
    if (s ~ /checkVolume|toVolume|checkParametricVolume/)                return "ParametricVolume"
    if (s ~ /checkUnivariateFunction|toUnivariateFunction/)              return "UnivariateFunction"
    if (s ~ /checkStructuredGrid/)                                       return "StructuredGrid"
    if (s ~ /checkUnstructuredGrid/)                                     return "UnstructuredGrid"
    if (s ~ /getIntegerFromTable|lua_tointeger|luaL_checkinteger|getInt\(/) return "integer"
    if (s ~ /getNumberFromTable|lua_tonumber|luaL_checknumber|getDouble\(/) return "number"
    if (s ~ /getBooleanFromTable|lua_toboolean|getBool\(/)               return "boolean"
    if (s ~ /getStringFromTable|lua_tostring|luaL_checkstring|getString\(/) return "string"
    return ""
}
function flush_doc() { doc = ""; docopen = 0 }
FNR == 1 { flush_doc(); infn = 0; incomment = 0 }
{
    raw = $0
    if (!infn) {
        # Collect the comment block immediately preceding a function.
        if (incomment) {
            t = raw
            if (t ~ /\*\//) { sub(/[ \t]*\*+\/.*$/, "", t); incomment = 0 }
            sub(/^[ \t]*\*?[ \t]?/, "", t)
            if (!banner(t)) doc = doc clean(t) "\\n"
            next
        }
        if (raw ~ /^[ \t]*\/\*/) {
            t = raw; sub(/^[ \t]*\/\*+[ \t]?/, "", t)
            if (raw ~ /\*\//) sub(/[ \t]*\*+\/.*$/, "", t); else incomment = 1
            if (docopen == 0) doc = ""
            docopen = 1
            if (t != "" && !banner(t)) doc = doc clean(t) "\\n"
            next
        }
        if (raw ~ /^[ \t]*\/\//) {
            t = raw; sub(/^[ \t]*\/\/+[ \t]?/, "", t)
            if (docopen == 0) doc = ""
            docopen = 1
            if (!banner(t)) doc = doc clean(t) "\\n"
            next
        }
        if (match(raw, /^[ \t]*extern[ \t]*\([ \t]*C[ \t]*\)[ \t]+int[ \t]+([A-Za-z_][A-Za-z0-9_]*)/, m)) {
            infn = 1; fname = m[1]; fline = FNR; allowed = ""; usage = ""; types = ""
            delete seen_t; collecting = ""; pendkey = ""; pendlines = 0
            fdoc = doc; flush_doc()
            next
        }
        if (raw ~ /^[ \t]*@[a-z]+[ \t]*$/ || raw ~ /^[ \t]*$/) next   # attributes / blank lines keep the doc
        flush_doc()
        next
    }
    # ---- inside an extern(C) function body ----
    if (collecting != "" || raw ~ /checkAllowedNames\(/) {
        collecting = collecting " " raw
        if (collecting ~ /\]/) {
            c = collecting; sub(/^[^\[]*\[/, "", c); sub(/\].*$/, "", c)
            while (match(c, /"([^"]+)"/, mm)) { allowed = allowed (allowed == "" ? "" : ",") mm[1]; c = substr(c, RSTART + RLENGTH) }
            collecting = ""
        }
    }
    if (usage == "" && match(raw, /"(Expected[^"]*[:.][A-Za-z_]+[ \t]*[{(][^"]*)"/, m)) {
        usage = m[1]; sub(/^Expected:?[ \t]*/, "", usage); sub(/[;.][ \t]*$/, "", usage)
    }
    if (match(raw, /[A-Za-z]+FromTable\([^,]+,[^,]+,[ \t]*"([A-Za-z_][A-Za-z0-9_]*)"/, m)) {
        t = guess(raw); if (t != "") addtype(m[1], t)
    } else if (match(raw, /lua_getfield\([^,]+,[ \t]*-?[0-9]+[ \t]*,[ \t]*"([A-Za-z_][A-Za-z0-9_]*)"/, m)) {
        pendkey = m[1]; pendlines = 12
    } else if (pendkey != "") {
        # The value is read between lua_getfield and the matching lua_pop.
        t = guess(raw)
        if (t != "") { addtype(pendkey, t); pendkey = "" }
        else if (raw ~ /lua_pop\(/ || --pendlines <= 0) pendkey = ""
    }
    if (raw ~ /^}/) {
        f = FILENAME; sub(SRC, "", f)
        print fname "\t" f "\t" fline "\t" allowed "\t" clean(usage) "\t" types "\t" fdoc
        infn = 0
    }
}' "${dfiles[@]}" > "$work/dfuncs.tsv"

# ---------------------------------------------------------------------------
# 1d. config.* field docs from lmr/globalconfig.d (class GlobalConfig).
#   configdoc.tsv: name  dType  default  doc
# ---------------------------------------------------------------------------
gawk '
function clean(s) { gsub(/\t/, " ", s); gsub(/\\/, "\\\\", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
/^[ \t]*\/\// { t = $0; sub(/^[ \t]*\/\/+[ \t]?/, "", t); if (t !~ /^[-=]*$/) pre = pre clean(t) "\\n"; next }
match($0, /^[ \t]*shared[ \t]+static[ \t]+([A-Za-z_][A-Za-z0-9_!()\[\]]*)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(=[ \t]*([^;]*))?;[ \t]*(\/\/+[ \t]*(.*))?$/, m) {
    if (!(m[2] in seen)) {
        seen[m[2]] = 1
        d = m[6] != "" ? clean(m[6]) : pre
        print m[2] "\t" m[1] "\t" clean(m[4]) "\t" d
    }
    pre = ""; next
}
{ pre = "" }' "$src/lmr/globalconfig.d" > "$work/configdoc.tsv"

# ---------------------------------------------------------------------------
# 1e. Enum options for string-valued config fields.
#   update_enum("json_key", "field", "x_from_name")  +  case "opt": inside x_from_name()
#   enums.tsv: configKey  opt1,opt2,...  hyphensNormalised(0/1)
# ---------------------------------------------------------------------------
gawk '
match($0, /update_enum\("([A-Za-z_0-9]+)",[ \t]*"[A-Za-z_0-9]+",[ \t]*"([A-Za-z_0-9]+)"\)/, m) { keyfn[m[1]] = m[2]; next }
match($0, /^[A-Za-z_]+[ \t]+([a-z_0-9]+_from_name)\(string/, m) { cur = m[1]; next }
cur != "" && /replace\("-",[ \t]*"_"\)/ { hy[cur] = 1 }
cur != "" && /default:/ { cur = ""; next }
cur != "" {
    s = $0
    while (match(s, /case[ \t]+"([^"]+)"[ \t]*:/, mm)) {
        if (!((cur, mm[1]) in have)) { have[cur, mm[1]] = 1; opts[cur] = opts[cur] (opts[cur] == "" ? "" : ",") mm[1] }
        s = substr(s, RSTART + RLENGTH)
    }
}
END { for (k in keyfn) if (keyfn[k] in opts) print k "\t" opts[keyfn[k]] "\t" (keyfn[k] in hy ? 1 : 0) }
' "$src/lmr/globalconfig.d" > "$work/enums.tsv"

# ---------------------------------------------------------------------------
# 1f. Fields of plain-table "instances" built in D, e.g. a GasState table is
#     filled by pushNewGasTable()/setGasStateInTable() with lua_setfield calls.
#   instfields.tsv: className  field  luaType
# ---------------------------------------------------------------------------
instance_sources=(
    "GasState|gas/luagas_model.d|pushNewGasTable setGasStateInTable"
)
for spec in "${instance_sources[@]}"; do
    IFS='|' read -r cls file fns <<< "$spec"
    [[ -f "$src/$file" ]] || continue
    gawk -v CLS="$cls" -v FNS="$fns" '
    BEGIN { n = split(FNS, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 }
    match($0, /^[A-Za-z_][A-Za-z0-9_()\[\]*]*[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/, m) && !/;[ \t]*$/ { infn = (m[1] in want) }
    infn && /^}/ { infn = 0 }
    infn {
        if (/lua_pushnumber|lua_pushinteger/) last = "number"
        else if (/lua_pushstring/) last = "string"
        else if (/lua_pushboolean/) last = "boolean"
        else if (/lua_newtable|lua_createtable/) last = "table"
        if (match($0, /lua_setfield\([^,]+,[ \t]*[^,]+,[ \t]*"([A-Za-z_][A-Za-z0-9_]*)"/, m) && !seen[m[1]]++) {
            print CLS "\t" m[1] "\t" (last == "" ? "any" : last)
        }
    }' "$src/$file"
done > "$work/instfields.tsv"

cp "$script_dir/overrides.json" "$work/overrides.json" 2>/dev/null || echo '{}' > "$work/overrides.json"

for f in mtconst reg dfuncs configdoc enums instfields; do
    printf 'gen-eilmer-api:   %-10s %6d records\n' "$f" "$(wc -l < "$work/$f.tsv")" >&2
done

# ---------------------------------------------------------------------------
# 2. Runtime introspection + merge, run inside the real lmr Lua environment.
# ---------------------------------------------------------------------------
# A tiny gas model lets introspect.lua build real FlowState/GasState instances
# and record their fields. Failure here is not fatal.
printf "model = 'IdealGas'\nspecies = {'air'}\n" > "$work/ideal-air.lua"
( cd "$work" && "$lmr_bin" prep-gas -i ideal-air.lua -o ideal-air.gas >/dev/null 2>&1 ) \
    || echo "gen-eilmer-api: warning: lmr prep-gas failed; instance fields will be limited" >&2

revision="$(git -C "$repo" log -1 --format='%h %cI' 2>/dev/null || echo unknown)"
lmr_rev="$("$lmr_bin" revision-id 2>/dev/null | head -1 || true)"
mkdir -p "$(dirname "$out")"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"

(
    cd "$work"
    export EILMER_API_WORK="$work" EILMER_API_OUT="$out_abs" EILMER_API_INST="$inst" \
           EILMER_API_REPO="$repo" EILMER_API_REV="$revision" EILMER_API_LMRREV="$lmr_rev"
    "$lmr_bin" custom-script --job="$script_dir/introspect.lua"
) >&2

[[ -s "$out_abs" ]] || die "introspection did not produce $out_abs"
echo "gen-eilmer-api: wrote $out_abs ($(wc -c < "$out_abs") bytes)" >&2
