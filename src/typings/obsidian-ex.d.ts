import "obsidian";
declare module "obsidian" {

	export interface DataAdapter {
		getBasePath(): string;
	}
}
