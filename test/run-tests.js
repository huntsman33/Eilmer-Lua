// Plain-node tests: node test/run-tests.js [extra dirs to scan for false positives...]
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checkText, buildIndex } = require('../src/diagnostics');
const { generateMeta } = require('../src/metagen');

const api = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'eilmer-api.json'), 'utf8'));
const index = buildIndex(api);
let failures = 0;

function test(name, fn) {
    try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const codes = (src) => checkText(src, index).map((d) => `${d.code}:${src.slice(d.start, d.end)}`);

console.log('diagnostics');
test('valid cone tutorial script has no findings', () => {
    const src = `
a0 = {x=0.0, y=0.0}; b0 = {x=0.2, y=0.0}; b1 = {x=0.2, y=1.0}; a1 = {x=0.0, y=1.0}
quad0 = CoonsPatch:new{p00=a0, p10=b0, p11=b1, p01=a1}
grid0 = registerFluidGrid{
   grid=StructuredGrid:new{psurface=quad0, niv=11, njv=41},
   fsTag="inflow", bcTags={west="inflow"}
}
identifyGridConnections()
config.solver_mode = "transient"
config.axisymmetric = true
config.gasdynamic_update_scheme = "predictor-corrector"
config.flux_calculator = 'adaptive_hanel_ausmdv'
inflow = FlowState:new{p=95.84e3, T=1103.0, velx=1000.0}
bcDict = { inflow=InFlowBC_Supersonic:new{flowState=inflow}, outflow=OutFlowBC_Simple:new{} }
config.max_time = 5.0e-3
`;
    assert.deepStrictEqual(codes(src), []);
});
test('X.new{} flagged with colon fix', () => {
    const d = checkText('p = Line.new{p0={x=0}, p1={x=1}}\nconfig.max_time=1', index);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].code, 'eilmer-colon-call');
    assert.strictEqual(d[0].fix.text, ':');
});
test('unknown constructor key, with suggestion', () => {
    const d = checkText('g = StructuredGrid:new{psurface=s, nvi=11, njv=41}', index);
    assert.deepStrictEqual(d.map((x) => x.code), ['eilmer-unknown-key']);
    assert.match(d[0].message, /Did you mean 'niv'/);
});
test('unknown key in nested constructor inside registerFluidGrid', () => {
    assert.deepStrictEqual(codes('registerFluidGrid{grid=StructuredGrid:new{psurface=q, niv=3, njv=3}, fstag="x"}'),
        ['eilmer-unknown-key:fstag']);
});
test('unknown config field (assignment = error, read = warning)', () => {
    const d = checkText('config.max_tme = 1.0\nprint(config.dt_plott)\nconfig.dimensions = 2', index);
    assert.deepStrictEqual(d.map((x) => [x.code, x.severity]), [['eilmer-unknown-setting', 0], ['eilmer-unknown-setting', 1]]);
    assert.match(d[0].message, /max_time/);
});
test('invalid enum option', () => {
    assert.deepStrictEqual(codes('config.flux_calculator = "ausmd"\nconfig.dimensions=2'), ['eilmer-invalid-option:ausmd']);
});
test('config{...} call form', () => {
    assert.deepStrictEqual(codes('config{max_time=1.0, cfl_valu=0.5}\nconfig.dimensions=2'), ['eilmer-unknown-setting:cfl_valu']);
});
test('comments and strings are ignored', () => {
    assert.deepStrictEqual(codes('-- Line.new{bogus=1}\nx = "config.nope = 1"\n--[[ StructuredGrid:new{zzz=1} ]]\nconfig.max_time=1'), []);
});
test('non-Eilmer Lua files are skipped', () => {
    assert.deepStrictEqual(codes('local t = {}\nfunction t.new(o) return o end\nx = t.new{a=1}'), []);
});
test('local shadowing a settings table is skipped', () => {
    assert.deepStrictEqual(codes('local config = {}\nconfig.whatever = 1\nregisterFluidGrid{grid=g}'), []);
});

console.log('metagen');
test('meta file contains key declarations', () => {
    const meta = generateMeta(api);
    assert.match(meta, /^---@meta eilmer/);
    assert.match(meta, /---@class Line : Path/);
    assert.match(meta, /function Line:new\(o\) end/);
    assert.match(meta, /---@field p0\? any \(Vector3\)/);
    assert.match(meta, /function registerFluidGrid\(o\) end/);
    assert.match(meta, /---@type eilmer\.settings\.config\nconfig = \{\}/);
    assert.match(meta, /---@field flux_calculator\? "ausmdv"\|/);
    assert.match(meta, /---@class GasState\n(---@field \w+ \w+\n)*---@field a number/);
    assert.match(meta, /---@return GasModel gmodel/);
});

console.log('portability');
test('dictionary contains no machine-specific absolute paths', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'eilmer-api.json'), 'utf8');
    const hits = raw.match(/"(\/home\/|\/Users\/|[A-Z]:\\\\)[^"]*"/g) || [];
    assert.deepStrictEqual(hits.slice(0, 3), []);
    assert.strictEqual(api.globals.Line.methods.new.file, 'src/geom/luawrap/luagpath.d');
    assert.strictEqual(api.globals.registerFluidGrid.file, 'src/lmr/lua-modules/prepgrids.lua');
});
test('hover links default to gdtk on GitHub at the dictionary revision', () => {
    const rev = api.meta.gdtkRevision.split(' ')[0];
    assert.ok(generateMeta(api).includes(
        `(https://github.com/gdtk-uq/gdtk/blob/${rev}/src/geom/luawrap/luagpath.d#L`));
});
test('custom resolver is used for links', () => {
    const meta = generateMeta(api, { resolveFile: (f, l) => `file:///gdtk/${f}#L${l}` });
    assert.ok(meta.includes('](file:///gdtk/src/lmr/lua-modules/prepgrids.lua#L'));
});

// False-positive sweep over real Eilmer input scripts.
const dirs = process.argv.slice(2);
const defaults = [path.join(process.env.DGD_REPO || path.join(process.env.HOME, 'gdtk'), 'examples', 'lmr')];
console.log('false-positive sweep');
for (const dir of dirs.length ? dirs : defaults) {
    if (!fs.existsSync(dir)) { console.log(`  skip ${dir} (missing)`); continue; }
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!/^(lmrsim|node_modules|\.git)$/.test(e.name)) walk(p); }
            else if (e.name.endsWith('.lua')) files.push(p);
        }
    })(dir);
    let n = 0;
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const ds = checkText(src, index);
        for (const d of ds) {
            n++;
            const line = src.slice(0, d.start).split('\n').length;
            if (n <= 40) console.log(`  ${path.relative(dir, f)}:${line}: [${d.code}] ${d.message}`);
        }
    }
    console.log(`  ${dir}: ${files.length} .lua files, ${n} findings`);
}

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
