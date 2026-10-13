// diagnostics.js -- Eilmer-specific checks on Lua input scripts.
// Pure functions (no vscode import) so they can be unit-tested with plain node.
//
// Checks:
//   1. X.new{...} where X:new{...} is required (Eilmer raises an error at prep time).
//   2. Unknown keys in constructor / function table arguments, e.g. Line:new{p0=a, p2=b}
//      (Eilmer's checkAllowedNames raises an error at prep time).
//   3. Unknown fields on settings tables: config.max_tme = 1.0
//      (Eilmer silently ignores these apart from a printed message).
//   4. Invalid option strings for enum-valued settings: config.flux_calculator = "ausm"
'use strict';

const SEVERITY = { error: 0, warning: 1, information: 2, hint: 3 };

/**
 * Lex a Lua source: return a copy with comments and string contents blanked
 * (offsets preserved), plus the list of string literals.
 */
function maskLua(text) {
    const chars = text.split('');
    const strings = [];
    const n = text.length;
    let i = 0;
    const blank = (from, to) => {
        for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' ';
    };
    const longBracket = (pos) => {
        const m = /^\[(=*)\[/.exec(text.slice(pos, pos + 64));
        return m ? m[1].length : -1;
    };
    while (i < n) {
        const c = text[i];
        if (c === '-' && text[i + 1] === '-') {
            const lvl = text[i + 2] === '[' ? longBracket(i + 2) : -1;
            let end;
            if (lvl >= 0) {
                const close = ']' + '='.repeat(lvl) + ']';
                const j = text.indexOf(close, i + 4 + lvl);
                end = j < 0 ? n : j + close.length;
            } else {
                const j = text.indexOf('\n', i);
                end = j < 0 ? n : j;
            }
            blank(i, end);
            i = end;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            let value = '';
            while (j < n && text[j] !== c && text[j] !== '\n') {
                if (text[j] === '\\' && j + 1 < n) { value += text[j + 1]; j += 2; continue; }
                value += text[j];
                j++;
            }
            const end = Math.min(j + 1, n);
            strings.push({ start: i, end, value });
            blank(i + 1, end - 1);
            i = end;
        } else if (c === '[' && longBracket(i) >= 0) {
            const lvl = longBracket(i);
            const close = ']' + '='.repeat(lvl) + ']';
            const j = text.indexOf(close, i + 2 + lvl);
            const end = j < 0 ? n : j + close.length;
            strings.push({ start: i, end, value: text.slice(i + 2 + lvl, j < 0 ? n : j) });
            blank(i + 2 + lvl, j < 0 ? n : j);
            i = end;
        } else {
            i++;
        }
    }
    return { masked: chars.join(''), strings };
}

/** Find the offset of the bracket matching the one at `open` in masked text. */
function matchBracket(masked, open) {
    const pairs = { '{': '}', '(': ')', '[': ']' };
    const stack = [];
    for (let i = open; i < masked.length; i++) {
        const c = masked[i];
        if (pairs[c]) stack.push(pairs[c]);
        else if (c === '}' || c === ')' || c === ']') {
            if (stack.pop() !== c) return -1;
            if (stack.length === 0) return i;
        }
    }
    return -1;
}

/** Top-level `key = value` entries of the table constructor spanning [open, close]. */
function tableKeys(masked, open, close) {
    const keys = [];
    let depth = 0;
    let atItemStart = true;
    for (let i = open + 1; i < close; i++) {
        const c = masked[i];
        if (c === '{' || c === '(' || c === '[') { depth++; atItemStart = false; continue; }
        if (c === '}' || c === ')' || c === ']') { depth--; continue; }
        if (depth > 0) continue;
        if (c === ',' || c === ';') { atItemStart = true; continue; }
        if (/\s/.test(c)) continue;
        if (atItemStart) {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(masked.slice(i, i + 200));
            if (m) keys.push({ name: m[1], start: i, end: i + m[1].length });
            atItemStart = false;
        }
    }
    return keys;
}

// Edit distance counting a swap of adjacent letters as one edit (nvi -> niv).
function editDistance(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
            }
        }
    }
    return dp[a.length][b.length];
}

function closest(name, candidates, max = 3) {
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
        const d = editDistance(name, c);
        if (d < bestD) { best = c; bestD = d; }
    }
    return bestD <= Math.max(1, Math.min(max, Math.floor(name.length / 3))) ? best : null;
}

/** Pre-compute lookup tables from the API dictionary. */
function buildIndex(api) {
    const g = (api && api.globals) || {};
    const callables = new Map();   // "Line:new" / "registerFluidGrid" -> record
    const settings = new Map();    // "config" -> fields
    const markers = new Set();     // names whose presence marks a file as an Eilmer script
    for (const [name, d] of Object.entries(g)) {
        if (d.internal) continue;
        if (d.kind === 'function') {
            callables.set(name, d);
            if (name.length > 5) markers.add(name);
        } else if (d.kind === 'class') {
            for (const [m, md] of Object.entries(d.methods || {})) callables.set(`${name}:${m}`, md);
            if (name.length > 3) markers.add(name);
        } else if (d.kind === 'settings') {
            settings.set(name, d.fields || {});
            markers.add(name);
        }
    }
    return { globals: g, callables, settings, markers };
}

function looksLikeEilmerScript(masked, index) {
    const re = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    let m;
    let hits = 0;
    while ((m = re.exec(masked)) !== null) {
        if (index.markers.has(m[0]) && m[0] !== 'config') return true;
        if (m[0] === 'config' && /^\s*[.{(]/.test(masked.slice(re.lastIndex, re.lastIndex + 3))) hits++;
        if (hits >= 2) return true;
    }
    return false;
}

function precededByAccess(masked, start) {
    let k = start - 1;
    while (k >= 0 && /[ \t]/.test(masked[k])) k--;
    return k >= 0 && (masked[k] === '.' || masked[k] === ':') && masked[k - 1] !== '.';
}

/**
 * Run all checks.
 * @returns {Array<{start:number,end:number,severity:number,message:string,code:string,fix?:{start:number,end:number,text:string,title:string}}>}
 */
function checkText(text, index, opts = {}) {
    const { masked, strings } = maskLua(text);
    if (!opts.force && !looksLikeEilmerScript(masked, index)) return [];
    const out = [];
    const stringAt = new Map(strings.map((s) => [s.start, s]));

    // Locals that shadow Eilmer globals (e.g. `local config = {}`) are skipped.
    const shadowed = new Set();
    for (const m of masked.matchAll(/\blocal\s+(?:function\s+)?([A-Za-z_][\w\s,]*)/g)) {
        for (const nm of m[1].split(',')) shadowed.add(nm.trim().split(/\s+/)[0]);
    }

    // 1 & 2: calls with a table argument:  X:m{...}  X.m{...}  X:m({...})  f{...}  f({...})
    const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)(?:\s*([:.])\s*([A-Za-z_][A-Za-z0-9_]*))?\s*(\(\s*)?\{/g;
    let m;
    while ((m = callRe.exec(masked)) !== null) {
        const [whole, owner, sep, method] = m;
        if (precededByAccess(masked, m.index) || shadowed.has(owner)) continue;
        if (/^(function|local|return|and|or|not|in|then|do|else|until)$/.test(owner)) continue;
        const key = method ? `${owner}:${method}` : owner;
        const rec = index.callables.get(key);
        if (!rec) continue;
        const open = m.index + whole.length - 1;
        const close = matchBracket(masked, open);
        if (close < 0) continue;

        if (method && sep === '.' && rec.call === ':') {
            const sepOff = m.index + whole.indexOf('.', owner.length);
            out.push({
                start: m.index, end: m.index + whole.indexOf(method, owner.length) + method.length,
                severity: SEVERITY.error, code: 'eilmer-colon-call',
                message: `Use ${owner}:${method}{...} (colon), not ${owner}.${method}{...}. Eilmer raises an error for the dot form.`,
                fix: { start: sepOff, end: sepOff + 1, text: ':', title: `Change to ${owner}:${method}` },
            });
        }
        if (rec.params && rec.params.length && !rec.paramsOpen) {
            const allowed = rec.params.map((p) => p.name);
            const allowedSet = new Set(allowed);
            for (const k of tableKeys(masked, open, close)) {
                if (allowedSet.has(k.name)) continue;
                const guess = closest(k.name, allowed);
                const display = method ? `${owner}:${method}{}` : `${owner}{}`;
                out.push({
                    start: k.start, end: k.end, severity: SEVERITY.error, code: 'eilmer-unknown-key',
                    message: `'${k.name}' is not a valid key for ${display}.` +
                        (guess ? ` Did you mean '${guess}'?` : '') + ` Allowed: ${allowed.join(', ')}.`,
                    fix: guess ? { start: k.start, end: k.end, text: guess, title: `Change to '${guess}'` } : undefined,
                });
            }
        }
        callRe.lastIndex = open + 1;  // keep scanning inside for nested constructors
    }

    // 3 & 4: settings tables (config, NewtonKrylovGlobalConfig)
    for (const [sname, fields] of index.settings) {
        if (shadowed.has(sname)) continue;
        const names = Object.keys(fields);
        const re = new RegExp(`\\b${sname}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, 'g');
        while ((m = re.exec(masked)) !== null) {
            if (precededByAccess(masked, m.index)) continue;
            const field = m[1];
            const fStart = m.index + m[0].length - field.length;
            const fEnd = fStart + field.length;
            const after = masked.slice(fEnd, fEnd + 200);
            const assign = /^\s*=(?!=)\s*/.exec(after);
            if (!fields[field]) {
                const guess = closest(field, names);
                out.push({
                    start: fStart, end: fEnd,
                    severity: assign ? SEVERITY.error : SEVERITY.warning, code: 'eilmer-unknown-setting',
                    message: `'${sname}.${field}' is not an Eilmer setting` +
                        (assign ? '; Eilmer will ignore this assignment.' : '.') +
                        (guess ? ` Did you mean '${guess}'?` : ''),
                    fix: guess ? { start: fStart, end: fEnd, text: guess, title: `Change to '${guess}'` } : undefined,
                });
                continue;
            }
            const f = fields[field];
            if (assign && f.options && f.options.length) {
                const s = stringAt.get(fEnd + assign[0].length);
                if (s && s.end <= text.length && /^["']/.test(text[s.start])) {
                    checkOption(out, sname, field, f, s);
                }
            }
        }
        // config{ key = value, ... } call form
        const callForm = new RegExp(`\\b${sname}\\s*(\\(\\s*)?\\{`, 'g');
        while ((m = callForm.exec(masked)) !== null) {
            if (precededByAccess(masked, m.index)) continue;
            const open = m.index + m[0].length - 1;
            const close = matchBracket(masked, open);
            if (close < 0) continue;
            for (const k of tableKeys(masked, open, close)) {
                if (fields[k.name]) {
                    const f = fields[k.name];
                    const after = masked.slice(k.end, k.end + 200);
                    const eq = /^\s*=\s*/.exec(after);
                    const s = eq && stringAt.get(k.end + eq[0].length);
                    if (f.options && f.options.length && s) checkOption(out, sname, k.name, f, s);
                    continue;
                }
                const guess = closest(k.name, names);
                out.push({
                    start: k.start, end: k.end, severity: SEVERITY.error, code: 'eilmer-unknown-setting',
                    message: `'${k.name}' is not an Eilmer ${sname} setting; Eilmer will ignore it.` +
                        (guess ? ` Did you mean '${guess}'?` : ''),
                    fix: guess ? { start: k.start, end: k.end, text: guess, title: `Change to '${guess}'` } : undefined,
                });
            }
        }
    }
    return out;
}

function checkOption(out, sname, field, f, s) {
    const norm = (v) => (f.hyphensNormalised ? v.replace(/-/g, '_') : v);
    if (f.options.includes(norm(s.value))) return;
    const guess = closest(norm(s.value), f.options, 4);
    out.push({
        start: s.start + 1, end: s.end - 1, severity: SEVERITY.error, code: 'eilmer-invalid-option',
        message: `"${s.value}" is not a valid value for ${sname}.${field}.` +
            (guess ? ` Did you mean "${guess}"?` : '') + ` Options: ${f.options.join(', ')}.`,
        fix: guess ? { start: s.start + 1, end: s.end - 1, text: guess, title: `Change to "${guess}"` } : undefined,
    });
}

module.exports = { checkText, buildIndex, maskLua, tableKeys, SEVERITY };
