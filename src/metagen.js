// metagen.js -- turn eilmer-api.json into a LuaCATS definition file (---@meta)
// that the sumneko Lua language server uses for hover, completion and
// undefined-global/undefined-field diagnostics.
'use strict';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LUA_KEYWORDS = new Set(('and break do else elseif end false for function goto if in local nil not or ' +
    'repeat return then true until while').split(' '));

// Abstract base classes used by the D bindings but not exposed as globals.
const BASE_CLASS_DOCS = {
    Path: 'A parametric curve C(t), 0 <= t <= 1 (Line, Arc, Bezier, Spline, ...).',
    ParametricSurface: 'A parametric surface S(r, s), 0 <= r, s <= 1 (CoonsPatch, AOPatch, ...).',
    ParametricVolume: 'A parametric volume V(r, s, t), 0 <= r, s, t <= 1 (TFIVolume, ...).',
    UnivariateFunction: 'A clustering/distribution function f(t) on [0, 1] (RobertsFunction, ...).',
};

const LUA_TYPE = {
    number: 'number', integer: 'integer', boolean: 'boolean', string: 'string',
};

function isIdent(name) {
    return IDENT.test(name) && !LUA_KEYWORDS.has(name);
}

function oneLine(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

const GDTK_GITHUB = 'https://github.com/gdtk-uq/gdtk';

// Default link target for a repo-relative path: the gdtk GitHub repo at the
// revision the dictionary was generated from. Paths only present in an
// install ("$DGD/...") have no public URL.
function githubResolver(revision) {
    const rev = (revision || '').split(' ')[0] || 'master';
    return (file, line) => (file.startsWith('$DGD/') ? null
        : `${GDTK_GITHUB}/blob/${rev}/${encodeURI(file)}#L${line || 1}`);
}

let resolveFile = githubResolver();   // replaced per generateMeta() call

function fileLink(file, line) {
    if (!file) return '';
    const url = resolveFile(file, line);
    return url ? `[${file}:${line || 1}](${url})` : `\`${file}:${line || 1}\``;
}

// Turn a raw source comment into markdown: fence example code, bullet "key: desc" lists.
function docToMarkdown(doc) {
    if (!doc) return [];
    const lines = doc.split('\n');
    const out = [];
    let inCode = false;
    const looksLikeCode = (l) =>
        /^\s*(local\s+)?[A-Za-z_][\w.\[\]]*\s*=\s*[^=]/.test(l) && /[{(:]|\d|"/.test(l) ||
        /^\s*[A-Za-z_][\w.]*\s*[:.]\s*[A-Za-z_]\w*\s*[({]/.test(l) ||
        /^\s*[A-Za-z_]\w*\s*\(.*\)\s*;?\s*$/.test(l) ||
        /^\s*(assert|print|for|if|end|local)\b/.test(l);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const code = looksLikeCode(l) || (inCode && /^\s{2,}\S/.test(l) && !/^\s*[-*]\s/.test(l));
        if (code && !inCode) { out.push('```lua'); inCode = true; }
        if (!code && inCode) { out.push('```'); inCode = false; }
        if (code) { out.push(l); continue; }
        const kv = l.match(/^\s*([A-Za-z_]\w*)\s*:\s+(.+)$/);
        if (kv && !/^(Input|Returns|Notes?|Example|Supported|Usage)$/i.test(kv[1])) {
            out.push(`- \`${kv[1]}\`: ${kv[2]}`);
        } else if (/^\s{2,}\S/.test(l) && out.length && out[out.length - 1].startsWith('- ')) {
            out[out.length - 1] += ' ' + l.trim();   // continuation of a bullet
        } else {
            out.push(l.replace(/^\s+/, ''));
        }
    }
    if (inCode) out.push('```');
    return out;
}

function commentBlock(lines) {
    return lines.map((l) => (l === '' ? '---' : '--- ' + l.replace(/\r/g, '')));
}

const STAGE_LABEL = {
    grid: 'prep-grid', sim: 'prep-sim', chem: 'reaction files (prep-reactions)',
    kinetics: 'energy-exchange files (prep-energy-exchange)', run: 'run-time UDFs',
};
function stagesLine(stages) {
    return stages && stages.length ? `_Available in: ${stages.map((s) => STAGE_LABEL[s] || s).join(', ')}._` : '';
}

function describeCallable(d, displayName, stages) {
    const md = [];
    md.push(...docToMarkdown(d.doc));
    if (d.usage) {
        md.push('', '**Usage**', '```lua', d.usage, '```');
    }
    if (d.params && d.params.length && !d.paramsOpen) {
        md.push('', `**Allowed keys:** ${d.params.map((p) => '`' + p.name + '`').join(', ')}`);
    }
    if (d.delegatesTo) md.push('', `Arguments are passed on to \`${d.delegatesTo}{}\`.`);
    if (d.stageNotes) {
        for (const note of Object.values(d.stageNotes)) md.push('', `_${note}_`);
    }
    if (d.inherited) md.push('', `_Inherited from \`${d.inherited}\`._`);
    const st = stagesLine(stages || d.stages);
    if (st) md.push('', st);
    const where = fileLink(d.file, d.line);
    if (where) md.push('', `Defined in ${where}` + (d.dfunc ? ` (\`${d.dfunc}\`)` : ''));
    if (md.length === 0) md.push(`\`${displayName}\``);
    return md;
}

function argsClassName(owner, method) {
    return `eilmer.args.${owner}${method ? '.' + method : ''}`;
}

function emitArgsClass(out, className, params, open) {
    out.push(`---@class ${className}`);
    for (const p of params) {
        if (!isIdent(p.name)) continue;
        // D-side types are heuristic, so they go in the description, not the type.
        const extra = p.type ? `(${p.type}) ` : '';
        out.push(`---@field ${p.name}? any ${oneLine(extra + (p.doc || ''))}`.trimEnd());
    }
    if (open) out.push('---@field [any] any');
    out.push('');
}

// Signature lines (---@param / ---@return) for a function or method.
function signature(d, argsClass, returnType) {
    if (d.returns && d.returns.length) {
        returnType = d.returns.map((r) => `${r.type}${r.name ? ' ' + r.name : ''}${r.doc ? ' # ' + oneLine(r.doc) : ''}`);
    }
    const out = [];
    const names = [];
    const args = d.args && d.args.length ? d.args : (d.params ? ['o'] : ['...']);
    args.forEach((a, i) => {
        if (a === '...') { out.push('---@param ... any'); names.push('...'); return; }
        const name = isIdent(a) ? a : `arg${i + 1}`;
        names.push(name);
        if (i === 0 && argsClass) out.push(`---@param ${name}? ${argsClass}|table`);
        else out.push(`---@param ${name}? any`);
    });
    for (const r of [].concat(returnType || [])) out.push(`---@return ${r}`);
    return { lines: out, names };
}

function emitFunction(out, name, d) {
    let argsClass = null;
    if (d.params && d.params.length) {
        argsClass = argsClassName(name);
        emitArgsClass(out, argsClass, d.params, d.paramsOpen);
    }
    out.push(...commentBlock(describeCallable(d, name)));
    const sig = signature(d, argsClass, 'any');
    out.push(...sig.lines);
    out.push(`function ${name}(${sig.names.join(', ')}) end`, '');
}

function emitClass(out, name, d, declared) {
    const parent = d.parent && d.parent !== name ? ` : ${d.parent}` : '';
    const ctor = d.methods && d.methods.new;
    const header = [];
    if (ctor && ctor.doc) header.push(...docToMarkdown(ctor.doc).slice(0, 12));
    const where = fileLink(d.file || (ctor && ctor.file), d.line || (ctor && ctor.line));
    if (where) header.push('', `Defined in ${where}`);
    if (stagesLine(d.stages)) header.push('', stagesLine(d.stages));
    out.push(...commentBlock(header));
    out.push(`---@class ${name}${parent}`);
    if (name === 'Vector3') {
        out.push('---@field x number', '---@field y number', '---@field z number');
    }
    for (const [fname, f] of Object.entries(d.fields || {})) {
        if (!isIdent(fname)) continue;
        out.push(`---@field ${fname} ${f.type === 'integer' ? 'integer' : (LUA_TYPE[f.type] || 'any')}`);
    }
    for (const [fname, f] of Object.entries(d.instanceFields || {})) {
        if (!isIdent(fname)) continue;
        out.push(`---@field ${fname} ${f.type === 'number' ? 'number' : 'any'}`);
    }
    out.push(`${name} = {}`, '');
    declared.add(name);

    for (const [mname, m] of Object.entries(d.methods || {})) {
        if (!isIdent(mname) || mname.startsWith('__')) continue;
        let argsClass = null;
        if (m.params && m.params.length) {
            argsClass = argsClassName(name, mname);
            emitArgsClass(out, argsClass, m.params, m.paramsOpen);
        }
        out.push(...commentBlock(describeCallable(m, `${name}:${mname}`, d.stages)));
        const sig = signature(m, argsClass, mname === 'new' ? name : 'any');
        out.push(...sig.lines);
        const sep = m.call === '.' ? '.' : ':';
        out.push(`function ${name}${sep}${mname}(${sig.names.join(', ')}) end`, '');
    }
}

function optionLiterals(f) {
    const set = new Set();
    for (const o of f.options) {
        set.add(o);
        if (f.hyphensNormalised && o.includes('_')) set.add(o.replace(/_/g, '-'));
    }
    return [...set].map((o) => JSON.stringify(o));
}

function emitSettings(out, name, d) {
    const cls = `eilmer.settings.${name}`;
    out.push(`---@class ${cls}`);
    for (const [fname, f] of Object.entries(d.fields || {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (!isIdent(fname)) continue;
        let ty = f.options && f.options.length ? optionLiterals(f).join('|')
            : (f.type === 'table' ? 'table|number' : (LUA_TYPE[f.type] || 'any'));
        if (f.type === 'number' || f.type === 'integer') ty = 'number';
        const def = f.default !== undefined && f.default !== null ? ` (default: ${JSON.stringify(f.default)})` : '';
        out.push(`---@field ${fname}? ${ty} ${oneLine((f.doc || '') + def)}`.trimEnd());
    }
    out.push(`---@overload fun(settings: ${cls})`);
    out.push('');
    const where = fileLink(d.file, 1);
    out.push(...commentBlock([
        `Eilmer settings table \`${name}\`. Unknown fields are **ignored** by Eilmer (it only prints a message).`,
        ...(where ? ['', `Defined in ${where}`] : []),
    ]));
    out.push(`---@type ${cls}`, `${name} = {}`, '');
}

function emitTable(out, name, d) {
    const cls = `eilmer.table.${name}`;
    out.push(`---@class ${cls}`);
    for (const [fname, f] of Object.entries(d.fields || {})) {
        if (!isIdent(fname)) continue;
        const v = f.value !== undefined && f.value !== null ? ` = ${JSON.stringify(f.value)}` : '';
        out.push(`---@field ${fname} ${LUA_TYPE[f.type] || 'any'}${v ? ' ' + v : ''}`);
    }
    out.push('');
    const where = fileLink(d.file, d.line);
    if (where) out.push(...commentBlock([`Defined in ${where}`]));
    out.push(`---@type ${cls}`, `${name} = {}`, '');
    for (const [mname, m] of Object.entries(d.methods || {})) {
        if (!isIdent(mname) || mname.startsWith('__')) continue;
        out.push(...commentBlock(describeCallable(m, `${name}.${mname}`)));
        const sig = signature(m, null, 'any');
        out.push(...sig.lines);
        out.push(`function ${name}${m.call === ':' ? ':' : '.'}${mname}(${sig.names.join(', ')}) end`, '');
    }
}

function emitValue(out, name, d) {
    const notes = [stagesLine(d.stages), ...Object.values(d.stageNotes || {}).map((n) => `_${n}_`)].filter(Boolean);
    if (notes.length) out.push(...commentBlock(notes));
    const v = d.value !== undefined && d.value !== null ? JSON.stringify(d.value) : null;
    out.push(`---@type ${LUA_TYPE[d.type] || 'any'}`);
    out.push(`${name} = ${v !== null && d.type !== 'userdata' ? v : 'nil'}`, '');
}

/**
 * @param {object} api parsed eilmer-api.json
 * @param {{resolveFile?: (file: string, line: number) => string|null}} [opts]
 *   resolveFile maps a repo-relative path to a link URL (default: gdtk on GitHub).
 * @returns {string} LuaCATS source
 */
function generateMeta(api, opts = {}) {
    const g = api.globals || {};
    const meta = api.meta || {};
    resolveFile = opts.resolveFile || githubResolver(meta.gdtkRevision);
    const out = [
        '---@meta eilmer',
        `-- Eilmer ${meta.lmrRevision || ''} Lua API definitions, generated by vscode-eilmer from eilmer-api.json.`,
        `-- gdtk revision: ${meta.gdtkRevision || 'unknown'}; dictionary generated ${meta.generated || '?'}.`,
        '-- Do not edit: regenerate with "Eilmer: Regenerate API Dictionary from gdtk Source".',
        '',
    ];
    const names = Object.keys(g).filter(isIdent).sort();
    const declared = new Set();

    // Base classes referenced as parents but not themselves globals.
    const parents = new Set(names.map((n) => g[n].parent).filter(Boolean));
    for (const p of [...parents].sort()) {
        if (!g[p] && isIdent(p)) {
            out.push(...commentBlock([BASE_CLASS_DOCS[p] || `Eilmer base class \`${p}\`.`]));
            out.push(`---@class ${p}`, '');
            declared.add(p);
        }
    }
    for (const name of names) {
        const d = g[name];
        switch (d.kind) {
            case 'class': emitClass(out, name, d, declared); break;
            case 'function': emitFunction(out, name, d); break;
            case 'settings': emitSettings(out, name, d); break;
            case 'module':
            case 'table': emitTable(out, name, d); break;
            case 'value': emitValue(out, name, d); break;
            default: break;
        }
    }
    return out.join('\n') + '\n';
}

module.exports = { generateMeta, docToMarkdown, githubResolver };
