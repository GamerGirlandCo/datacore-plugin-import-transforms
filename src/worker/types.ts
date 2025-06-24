export interface WorkerRequest {
	id: string;
	libDir: string;
	vaultRoot: string;
	vaultFiles: string[];

	version: string;
	package: string;
}
export interface WorkerResponse {
	id: string;
	package: string;
	version: string;
	content: {
		[pkg: string]: {
			entryPoint: string;
			baseDir: string;
			files: {
				path: string;
				transformed: string;
			}[];
		};
	};
}
