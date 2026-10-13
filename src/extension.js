// extension.js -- VS Code entry point for the Eilmer Lua extension.
//
// * Generates a LuaCATS definitions file from eilmer-api.json and registers it
//   with the sumneko Lua language server (Lua.workspace.library). sumneko then
//   provides hover docs, completion and undefined-global/-field diagnostics.
// * Adds Eilmer-specific diagnostics + quick fixes (see diagnostics.js).
// * Command to regenerate eilmer-api.json from the local gdtk source.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { generateMeta, githubResolver } = require('./metagen');
const { checkText, buildIndex } = require('./diagnostics');

let api = null;
let index = null;
let output = null;
let diagCollection = null;
const fixes = new Map();   // uri -> [{range, fix}]

function storageDir(context) {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function bundledJson(context) { return path.join(context.extensionPath, 'data', 'eilmer-api.json'); }
function userJson(context) { return path.join(storageDir(context), 'eilmer-api.json'); }
function metaDir(context) { return path.join(storageDir(context), 'library'); }

function expandHome(p) { return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
function gdtkRepo() {
    return expandHome(vscode.workspace.getConfiguration('eilmer').get('gdtkRepo')) ||
        process.env.DGD_REPO || path.join(os.homedir(), 'gdtk');
}
function gdtkInstall() {
    return expandHome(vscode.workspace.getConfiguration('eilmer').get('gdtkInstall')) ||
        process.env.DGD || path.join(os.homedir(), 'gdtkinst');
}

/**
 * Hover links: repo-relative paths in the dictionary open the local gdtk
 * checkout/install when the file exists there, else gdtk on GitHub.
 */
function makeResolver() {
    const github = githubResolver(api.meta && api.meta.gdtkRevision);
    const repo = gdtkRepo();
    const inst = gdtkInstall();
    return (file, line) => {
        const local = file.startsWith('$DGD/') ? path.join(inst, file.slice(5)) : path.join(repo, file);
        if (fs.existsSync(local)) return vscode.Uri.file(local).with({ fragment: `L${line || 1}` }).toString();
        return github(file, line);
    };
}

/** Load the API dictionary (regenerated copy wins over the bundled one) and write the meta file. */
function loadApi(context) {
    const file = fs.existsSync(userJson(context)) ? userJson(context) : bundledJson(context);
    api = JSON.parse(fs.readFileSync(file, 'utf8'));
    index = buildIndex(api);
    const dir = metaDir(context);
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, 'eilmer.lua');
    const text = generateMeta(api, { resolveFile: makeResolver() });
    if (!fs.existsSync(metaFile) || fs.readFileSync(metaFile, 'utf8') !== text) {
        fs.writeFileSync(metaFile, text);
    }
    output.appendLine(`Loaded ${file} (gdtk ${api.meta && api.meta.gdtkRevision}); definitions in ${metaFile}`);
}

/** Point the sumneko server at our definitions and (optionally) make undefined names errors. */
async function configureLuaLS(context, { quiet } = {}) {
    const cfg = vscode.workspace.getConfiguration('eilmer');
    const wantWorkspace = cfg.get('settingsTarget') === 'workspace' && vscode.workspace.workspaceFolders;
    const target = wantWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const lua = vscode.workspace.getConfiguration('Lua');
    const scopeValue = (key) => {
        const i = lua.inspect(key) || {};
        return (wantWorkspace ? i.workspaceValue : i.globalValue);
    };
    const dir = metaDir(context);
    let changed = false;

    const libs = [...(scopeValue('workspace.library') || [])];
    if (!libs.includes(dir)) {
        // drop stale copies of our own library path (e.g. from an older install location)
        const kept = libs.filter((p) => !/vscode-eilmer[/\\]library$/.test(p));
        kept.push(dir);
        await lua.update('workspace.library', kept, target);
        changed = true;
    }
    if (cfg.get('strictUndefined')) {
        const sev = { ...(scopeValue('diagnostics.severity') || {}) };
        if (sev['undefined-global'] !== 'Error' || sev['undefined-field'] !== 'Error') {
            sev['undefined-global'] = 'Error';
            sev['undefined-field'] = 'Error';
            await lua.update('diagnostics.severity', sev, target);
            changed = true;
        }
    }
    if (changed && !quiet) {
        vscode.window.showInformationMessage(
            `Eilmer: Lua language server configured (${wantWorkspace ? 'workspace' : 'user'} settings).`);
    }
    if (changed) output.appendLine(`Updated Lua.* settings in ${wantWorkspace ? 'workspace' : 'user'} scope.`);
}

// --------------------------------------------------------------------------
// Diagnostics
// --------------------------------------------------------------------------
const SEV = [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning,
    vscode.DiagnosticSeverity.Information, vscode.DiagnosticSeverity.Hint];

function refreshDiagnostics(doc) {
    if (doc.languageId !== 'lua' || !index) return;
    if (!vscode.workspace.getConfiguration('eilmer').get('diagnostics.enable')) {
        diagCollection.delete(doc.uri);
        return;
    }
    const found = checkText(doc.getText(), index);
    const diags = [];
    const docFixes = [];
    for (const f of found) {
        const range = new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end));
        const d = new vscode.Diagnostic(range, f.message, SEV[f.severity]);
        d.source = 'eilmer';
        d.code = f.code;
        diags.push(d);
        if (f.fix) {
            docFixes.push({
                diagnostic: d,
                range: new vscode.Range(doc.positionAt(f.fix.start), doc.positionAt(f.fix.end)),
                text: f.fix.text, title: f.fix.title,
            });
        }
    }
    diagCollection.set(doc.uri, diags);
    fixes.set(doc.uri.toString(), docFixes);
}

class EilmerQuickFix {
    provideCodeActions(doc, range) {
        const actions = [];
        for (const f of fixes.get(doc.uri.toString()) || []) {
            if (!f.diagnostic.range.intersection(range)) continue;
            const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
            a.edit = new vscode.WorkspaceEdit();
            a.edit.replace(doc.uri, f.range, f.text);
            a.diagnostics = [f.diagnostic];
            a.isPreferred = true;
            actions.push(a);
        }
        return actions;
    }
}

// --------------------------------------------------------------------------
// Regeneration from gdtk source
// --------------------------------------------------------------------------
function regenerate(context) {
    const script = path.join(context.extensionPath, 'scripts', 'gen-eilmer-api.sh');
    const out = userJson(context);
    const args = [script, '-r', gdtkRepo(), '-i', gdtkInstall(), '-o', out + '.tmp'];
    output.show(true);
    output.appendLine(`$ bash ${args.join(' ')}`);
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Eilmer: regenerating API dictionary…' },
        () => new Promise((resolve) => {
            const child = cp.spawn('bash', args, { env: { ...process.env, DGD_REPO: gdtkRepo(), DGD: gdtkInstall() } });
            child.stdout.on('data', (b) => output.append(b.toString()));
            child.stderr.on('data', (b) => output.append(b.toString()));
            child.on('error', (e) => { output.appendLine(String(e)); resolve(false); });
            child.on('close', (code) => {
                if (code === 0 && fs.existsSync(out + '.tmp')) {
                    fs.renameSync(out + '.tmp', out);
                    loadApi(context);
                    vscode.workspace.textDocuments.forEach(refreshDiagnostics);
                    vscode.window.showInformationMessage(
                        'Eilmer: API dictionary regenerated. The Lua server picks up the new definitions automatically.');
                    resolve(true);
                } else {
                    vscode.window.showErrorMessage('Eilmer: regeneration failed; see the "Eilmer" output channel.');
                    resolve(false);
                }
            });
        }));
}

function checkStaleness(context) {
    if (!vscode.workspace.getConfiguration('eilmer').get('checkStaleness')) return;
    const have = ((api.meta && api.meta.gdtkRevision) || '').split(' ')[0];
    cp.execFile('git', ['-C', gdtkRepo(), 'log', '-1', '--format=%h'], (err, stdout) => {
        const now = (stdout || '').trim();
        if (err || !now || !have || now === have) return;
        vscode.window.showInformationMessage(
            `Eilmer: your gdtk repository is at ${now} but the API dictionary was built from ${have}.`,
            'Regenerate', 'Not now',
        ).then((choice) => { if (choice === 'Regenerate') regenerate(context); });
    });
}

// --------------------------------------------------------------------------
async function activate(context) {
    output = vscode.window.createOutputChannel('Eilmer');
    diagCollection = vscode.languages.createDiagnosticCollection('eilmer');
    context.subscriptions.push(output, diagCollection);

    try {
        loadApi(context);
    } catch (e) {
        vscode.window.showErrorMessage(`Eilmer: could not load the API dictionary: ${e.message}`);
        return;
    }
    await configureLuaLS(context, { quiet: false });

    context.subscriptions.push(
        vscode.commands.registerCommand('eilmer.regenerate', () => regenerate(context)),
        vscode.commands.registerCommand('eilmer.configureLuaLS', () => configureLuaLS(context)),
        vscode.commands.registerCommand('eilmer.showInfo', () => {
            const m = api.meta || {};
            const n = Object.keys(api.globals || {}).length;
            vscode.window.showInformationMessage(
                `Eilmer API: ${n} globals; gdtk ${m.gdtkRevision}; generated ${m.generated}; definitions in ${metaDir(context)}`);
        }),
        vscode.languages.registerCodeActionsProvider({ language: 'lua' }, new EilmerQuickFix(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
        vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
        vscode.workspace.onDidChangeTextDocument((e) => refreshDiagnostics(e.document)),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            diagCollection.delete(doc.uri);
            fixes.delete(doc.uri.toString());
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('eilmer.diagnostics')) vscode.workspace.textDocuments.forEach(refreshDiagnostics);
            if (e.affectsConfiguration('eilmer.gdtkRepo') || e.affectsConfiguration('eilmer.gdtkInstall')) loadApi(context);
            if (e.affectsConfiguration('eilmer.settingsTarget') || e.affectsConfiguration('eilmer.strictUndefined')) {
                configureLuaLS(context);
            }
        }),
    );
    vscode.workspace.textDocuments.forEach(refreshDiagnostics);
    checkStaleness(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
