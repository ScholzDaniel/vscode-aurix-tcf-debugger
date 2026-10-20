import * as path from 'path';

export function resolveConfigPath(value: unknown, workspace: string | undefined): string | undefined {
	if (typeof value !== 'string' || value.trim() === '') {
		return undefined;
	}
	let resolved = value;
	if (workspace) {
		resolved = resolved.replaceAll('${workspaceFolder}', workspace);
		resolved = resolved.replaceAll('${workspaceRoot}', workspace);
	}
	resolved = resolved.replace(/\//g, path.sep);
	if (!path.isAbsolute(resolved) && workspace) {
		resolved = path.resolve(workspace, resolved);
	}
	return resolved;
}
