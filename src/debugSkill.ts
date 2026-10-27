import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const skillParts = ['.github', 'skills', 'aurix-debug-workflow', 'SKILL.md'];

async function statIfExists(file: string) {
	try {
		return await fs.lstat(file);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return undefined; }
		throw error;
	}
}

async function readInstalledSkill(folder: vscode.WorkspaceFolder): Promise<Buffer | undefined> {
	let location = folder.uri.fsPath;
	for (const [index, part] of skillParts.entries()) {
		location = path.join(location, part);
		const stat = await statIfExists(location);
		if (!stat) { return undefined; }
		if (stat.isSymbolicLink() || (index === skillParts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
			throw new Error(`Skill installation requires ordinary directories and a regular file, not links: ${location}`);
		}
	}
	return fs.readFile(location);
}

function assertWorkspace(folder: vscode.WorkspaceFolder): void {
	if (!vscode.workspace.isTrusted) {
		throw new Error('Trust this workspace before installing the Debug skill.');
	}
	if (vscode.env.remoteName || folder.uri.scheme !== 'file') {
		throw new Error('Open a local workspace folder. Debug MCP does not support remote workspaces.');
	}
	if (!vscode.workspace.workspaceFolders?.some(item => item.uri.toString() === folder.uri.toString())) {
		throw new Error('The selected workspace folder is no longer open.');
	}
}

function assertNotDirty(target: vscode.Uri): void {
	if (vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file'
		&& path.relative(document.uri.fsPath, target.fsPath) === '' && document.isDirty)) {
		throw new Error(`Save or discard unsaved changes before updating ${target.fsPath}.`);
	}
}

function normalizedText(text: string): string {
	return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export async function installDebugSkill(context: Pick<vscode.ExtensionContext, 'extensionUri'>): Promise<void> {
	try {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) { throw new Error('Open a local workspace folder before installing the Debug skill.'); }
		const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({
			placeHolder: 'Select the project to receive aurix-debug-workflow',
			ignoreFocusOut: true,
		});
		if (!folder) { return; }
		assertWorkspace(folder);
		const target = vscode.Uri.joinPath(folder.uri, ...skillParts);
		const template = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(
			context.extensionUri, 'skills', 'aurix-debug-workflow', 'SKILL.md',
		));
		const text = Buffer.from(template).toString('utf8');
		const existing = await readInstalledSkill(folder);
		assertNotDirty(target);
		if (existing && normalizedText(existing.toString('utf8')) === normalizedText(text)) {
			void vscode.window.showInformationMessage(`Debug skill is already up to date: ${target.fsPath}`);
			return;
		}
		if (existing) {
			const choice = await vscode.window.showWarningMessage(
				`Replace the existing Debug skill in "${folder.name}"?`,
				{ modal: true, detail: `${target.fsPath}\nLocal edits will be overwritten by the bundled template. Cancel to keep them.` },
				'Replace',
			);
			if (choice !== 'Replace') { return; }
		}

		assertWorkspace(folder);
		const current = await readInstalledSkill(folder);
		assertNotDirty(target);
		if (existing ? !current?.equals(existing) : current !== undefined) {
			throw new Error('The skill file changed during installation. Review it and run the command again.');
		}
		const edit = new vscode.WorkspaceEdit();
		let document: vscode.TextDocument | undefined;
		if (existing) {
			document = await vscode.workspace.openTextDocument(target);
			assertNotDirty(target);
			if (normalizedText(document.getText()) !== normalizedText(existing.toString('utf8'))) {
				throw new Error('The skill editor differs from the file on disk. Review it before updating.');
			}
			edit.replace(target, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
		} else {
			await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
			edit.createFile(target, { contents: template, overwrite: false });
		}
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error('VS Code could not apply the skill file edit.');
		}
		if (document && !await document.save()) {
			throw new Error('The updated skill could not be saved. Check the open editor and file permissions.');
		}
		assertNotDirty(target);
		if (normalizedText(await fs.readFile(target.fsPath, 'utf8')) !== normalizedText(text)) {
			throw new Error('The saved skill differs from the bundled template. Review the file before using it.');
		}
		void vscode.window.showInformationMessage(
			`${existing ? 'Updated' : 'Installed'} Debug skill: ${target.fsPath}. No debug session or hardware operation was started.`,
		);
	} catch (error) {
		void vscode.window.showErrorMessage(`Cannot install Debug skill: ${error instanceof Error ? error.message : String(error)}`);
	}
}
