import * as tw from "worker/transform.worker";
const TransformWorker = tw.default;
import { Plugin } from "obsidian";
import pathutils from "@chainner/node-path";
import { transform, traverse } from "@babel/core";
import { transformImportsAndExports, TransformOptions } from "./util";
import { parse } from "@babel/parser";
import { WorkerRequest, WorkerResponse } from "./worker/types";

interface Settings {
	downloadedNpmLibs: TransformOptions["importPaths"];
}

const DEFAULT_SETTINGS: Settings = {
	downloadedNpmLibs: {},
};

type PromiseResolver<T> = (value: T | PromiseLike<T>) => void;
type PromiseRejector = (reason?: any) => void;

export default class DatacoreJSTransformPlugin extends Plugin {
	private _settings: Settings;
	#pending: Map<
		string,
		{
			resolve: PromiseResolver<WorkerResponse>;
			reject: PromiseRejector;
		}
	> = new Map();
	#worker: Worker;
	static readonly exts = [".js", ".jsx", ".ts", ".tsx", ".mjs"];
	get libDir(): string {
		return this.manifest.dir + "/libs";
	}
	get settings(): Settings {
		return this._settings;
	}
	async onload() {
		await this.loadSettings();
		if (!(await this.app.vault.adapter.exists(this.libDir))) {
			await this.app.vault.adapter.mkdir(this.libDir);
		}
		this.#worker = new TransformWorker();
		this.#worker.onmessage = (ev) => {
			const data = ev.data as WorkerResponse;
			if (this.#pending.has(data.id)) {
				this.#pending.get(data.id)!.resolve(data);
				this.#pending.delete(data.id);
			}
		};
		this.#worker.onerror = (err) => {
			for (const { reject } of this.#pending.values()) {
				reject(err);
			}
			this.#pending.clear();
		};
	}
	async preTransform(
		srcPath: string,
		src: string,
		jsx: boolean,
		ts: boolean
	): Promise<string> {
		const topLevelmports = await this.traverseImports(src);
		const versions = await Promise.all(
			topLevelmports.map((pkg) => {
				let version: string;
				let rpkg = pkg.split("/").slice(0, 2).join("/");

				if (pkg.lastIndexOf("@") > 0) {
					version = pkg.substring(pkg.lastIndexOf("@") + 1);
					rpkg = pkg.substring(0, pkg.lastIndexOf("@"));
				} else {
					version = "latest";
				}
				return [rpkg, version];
			})
		);
		await Promise.all(versions.map(([k, v]) => this.addPackage(k, v)));
		/* const entries = Object.fromEntries(
			[...resolved.entries()].map(([k, vv]) => {
				const base = this.libDir + `/${k.replace("latest", vv.version)}`;
				return [
					(() => {
						const lio = k.lastIndexOf("@");
						if (lio > 0) {
							return k.substring(0, lio);
						}
						return k;
					})(),
					{
						files: vv.files.map((a) => this.computeBase(a, base)),
						baseDir: base,
						entryPoint: vv.entryPoint,
					},
				];
			})
		) */ return transform(src, {
			filename: srcPath,
			cwd: this.app.vault.adapter.getBasePath(),
			plugins: [
				[
					transformImportsAndExports,
					{
						outerBaseDir: pathutils.dirname(srcPath),
						vaultRoot: this.app.vault.adapter.getBasePath(),
						vaultFiles: this.app.vault.getFiles().map((a) => a.path),
						importPaths: { ...this._settings.downloadedNpmLibs },
					},
				],
				/* [
							transformExtraImports,
							{
								possiblePathEntries: Object.fromEntries([
									...dependencies.entries(),
								]),
							},
						], */
			],
		})?.code!;
		// return await transformImportsAndExports(src, this, ts, jsx);
	}
	async traverseImports(src: string) {
		const imports = new Set<string>();
		const parsed = parse(src, {
			plugins: ["jsx", "typescript"],
			sourceType: "module",
			allowReturnOutsideFunction: true,
			allowAwaitOutsideFunction: true,
			errorRecovery: true,
		});
		const p = this;
		traverse(parsed, {
			ImportDeclaration(path) {
				const node = path.node;
				if (
					!(
						[
							"react",
							"preact",
							"preact/hooks",
							"react-dom",
							"#datacore",
						].includes(node.source.value) ||
						p.app.vault.getFileByPath(node.source.value) ||
						node.source.value.includes("^") ||
						node.source.value.indexOf("#") > 0 ||
						node.source.value.startsWith("./") ||
						node.source.value.startsWith("..")
					) &&
					node.specifiers
				) {
					imports.add(node.source.value);
				}
			},
		});
		return [...imports];
	}
	async addPackage(src: string, v = "latest"): Promise<void> {
		console.log(`${src}@${v}`);
		if (
			!this._settings.downloadedNpmLibs[src] ||
			!this._settings.downloadedNpmLibs[src]?.files?.length
		) {
			const id = crypto.randomUUID();
			const resolved = await new Promise<WorkerResponse>((resolve, reject) => {
				this.#pending.set(id, { resolve, reject });
				this.#worker.postMessage({
					id,
					libDir: this.libDir,
					vaultRoot: this.app.vault.adapter.getBasePath(),
					vaultFiles: this.app.vault.getFiles().map((a) => a.path),
					version: v,
					package: src,
				} as WorkerRequest);
			});
			for (let k in resolved.content) {
				const cur = resolved.content[k];
				this._settings.downloadedNpmLibs[k] = {
					baseDir: cur.baseDir,
					entryPoint: cur.entryPoint,
					files: cur.files.map((a) => a.path),
				};
				for (let f of cur.files) {
					try {
						try {
							await this.app.vault.createFolder(pathutils.dirname(f.path));
						} catch (e) {}
						try {
							await this.app.vault.create(f.path, f.transformed);
						} catch (e) {
							await this.app.vault.adapter.remove(f.path);
							await this.app.vault.adapter.write(f.path, f.transformed);
						}
					} catch (ex) {
						console.error(ex);
						console.error(ex.stack)
					}
				}
			}
		}
	}

	onunload() {
		this.saveSettings();
		for (const { reject } of this.#pending.values()) {
			reject("unloading now. bye!");
		}
		this.#pending.clear();
		this.#worker.terminate();
	}

	async loadSettings() {
		this._settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this._settings);
	}
}
