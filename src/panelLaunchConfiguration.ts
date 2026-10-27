import * as vscode from 'vscode';

export async function savePanelLaunchConfiguration(
	folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration,
): Promise<void> {
	if (!folder) { throw new Error('Open a project folder before saving its debug configuration.'); }
	const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
	if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty)) {
		throw new Error('launch.json has unsaved changes. Save or revert them before clicking Debug.');
	}
	const launch = vscode.workspace.getConfiguration('launch', folder.uri);
	const configurations = launch.get<vscode.DebugConfiguration[]>('configurations') ?? [];
	if (!Array.isArray(configurations)) { throw new Error('launch.json configurations must be an array.'); }
	const index = configurations.findIndex(entry => entry?.type === 'aurix-tcf');
	const existing = index >= 0 ? configurations[index] : undefined;
	const saved: vscode.DebugConfiguration = {
		...existing, ...config,
		name: typeof existing?.name === 'string' && existing.name.trim() ? existing.name : config.name,
	};
	// Clearing an optional panel field must not leave its previous launch value active.
	for (const key of ['program', 'workspace', 'entryFunction', 'targetDevice', 'svdFile', 'svdPath', 'definitionPath',
		'ppuElfPath', 'cdspElfPaths', 'scrElfPath']) {
		if (!(key in config)) { delete saved[key]; }
	}
	const updated = [...configurations];
	if (index < 0) { updated.push(saved); }
	else { updated[index] = saved; }
	if (!launch.get<string>('version')) {
		await launch.update('version', '0.2.0', vscode.ConfigurationTarget.WorkspaceFolder);
	}
	await launch.update('configurations', updated, vscode.ConfigurationTarget.WorkspaceFolder);
}
