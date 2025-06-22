import { App, Modal, Plugin } from "obsidian";
import pako from "pako";
import untar, { type TarFile } from "js-untar";
import pathutils from "path-browserify-esm";

import { transform, traverse } from "@babel/core";
import {
	ImportArray,
	transformImportsAndExports,
	TransformOptions,
} from "./util";
import { transformExtraImports } from "./util";
import { parse, ParserPlugin } from "@babel/parser";
import types from "@babel/types";

interface Settings {
	downloadedNpmLibs: TransformOptions["importPaths"];
}

const DEFAULT_SETTINGS: Settings = {
	downloadedNpmLibs: {},
};

export default class DatacoreJSTransformPlugin extends Plugin {
	private _settings: Settings;
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
		for (let [k, v] of versions) {
			await this.addPackage(k, v);
		}
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
		) */;
		return transform(src, {
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
	async getPackage(
		pkg: string,
		version: string
	): Promise<{
		files: TarFile[];
		realVersion: string;
	}> {
		if (pkg.split("/").length > 2) {
			pkg = pkg.split("/").slice(0, 2).join("/");
		}
		const registryManifest = await fetch(`https://registry.npmjs.org/${pkg}`)
			.then((a) => a.json())
			.catch((a) => {
				console.error(a);
			});
		if (version == "latest")
			version =
				registryManifest["dist-tags"]?.latest ??
				Object.keys(registryManifest.versions)[
					Object.keys(registryManifest.versions).length - 1
				];
		let tarUrl = registryManifest.versions[version].dist.tarball;
		return {
			realVersion: version,
			files: await fetch(tarUrl)
				.catch((e) => {
					console.error(e);
					throw e;
				})
				.then(async (r) => {
					const ab = r.arrayBuffer();
					// console.log(ab);
					const a = await ab;
					const unzipped = pako.ungzip(a);
					return await untar(unzipped.buffer);
				}),
		};
	}
	async resolve(
		pkg: string,
		v = "latest"
	): Promise<
		Map<string, { files: TarFile[]; version: string; entryPoint: string }>
	> {
		const queue: [string, string][] = [[pkg, v]];
		let visited = new Map<
			string,
			{ files: TarFile[]; version: string; entryPoint: string }
		>();
		while (queue.length > 0) {
			let [cur, version] = queue.shift()!;
			if (!visited.has(`${cur}@${version}`)) {
				const { files: tar, realVersion } = await this.getPackage(cur, version);
				const packageFile = tar.find((a) =>
					a.name.startsWith("package/package.json")
				);
				if (!packageFile) continue;
				const packageJson = packageFile.readAsJSON();
				const modFiles: TarFile[] = [];
				if (packageJson.module) {
					let mod: string = packageJson.module;
					if (mod.startsWith(".")) mod = mod.substring(1);
					let modDir: string | null = null;
					if (mod.lastIndexOf("/") != -1 && mod.split("/").length > 2) {
						modDir = mod.substring(0, mod.lastIndexOf("/"));
					}
					if (modDir != null) {
						if (modDir.startsWith("./"))
							modDir = "package/" + modDir.substring(2);
						else modDir = "package/" + modDir;
						modFiles.push(
							...tar.filter(
								(a) => a.buffer.byteLength && a.name.startsWith(modDir!)
							)
						);
					} else {
						modFiles.push(...this.#getEsmFiles(tar));
					}
				}
				if (packageJson.files?.length) {
					modFiles.push(
						...packageJson.files
							.map((a: string) => {
								if (a.startsWith("/")) return "package" + a;
								else return "package/" + a;
							})
							.flatMap((a: string) => tar.filter((b) => b.name.startsWith(a)))
							.filter((a: TarFile) => !a.name.endsWith("json"))
					);
				}
				if (packageJson.exports) {
					modFiles.push(
						...Object.values(packageJson.exports)
							.map((a) => {
								if (Array.isArray(a)) return a[0];
								return a;
							})
							.map((a: { import: string; node: string; default: string }) => {
								if (a.import?.startsWith("./")) {
									a.import = a.import.substring(2);
								}
								return tar.find((b) =>
									b.name.startsWith("package/" + a.import)
								);
							})
							.filter((a) => !!a)
					);
				}
				modFiles.push(...tar);
				visited.set(`${cur}@${realVersion}`, {
					version: packageJson.version,
					entryPoint: packageJson.module,
					files: modFiles
						.filter((it, i, a) => a.findIndex((b) => b.name == it.name) == i)
						.filter(
							(a) =>
								DatacoreJSTransformPlugin.exts.includes(
									pathutils.extname(a.name)
								) &&
								!a.name.endsWith("map") &&
								a.buffer.byteLength
						),
				});
				queue.push(
					...Object.entries<string>(packageJson.dependencies ?? {}).map(
						([kk, vv]) => [kk, vv.replace(/[~\^\*]/gm, "")] as [string, string]
					)
				);
			}
		}
		return visited;
	}
	computeBase(f: TarFile, base: string): string {
		const dirs = f.name.split("/").slice(1);
		dirs.pop();
		const rname = f.name.split("/").slice(1).join("/");
		return base + "/" + rname;
	}
	async addPackage(src: string, v = "latest"): Promise<void> {
		console.log(`${src}@${v}`);
		if (
			!this._settings.downloadedNpmLibs[src] ||
			!this._settings.downloadedNpmLibs[src]?.files?.length
		) {
			const registryManifest = await fetch(`https://registry.npmjs.org/${src}`)
				.then((a) => a.json())
				.catch((a) => {
					console.error(a);
				});
			if (typeof registryManifest != "object") return;
			let version: string = v;
			if (src.lastIndexOf("@") > 0) {
				version = src.substring(src.lastIndexOf("@") + 1);
			} else if (registryManifest["dist-tags"]) {
				version = registryManifest["dist-tags"].latest;
			}
			const { files: tar } = await this.getPackage(src, version);
			const packageFile = tar.find((a) =>
				a.name.startsWith("package/package.json")
			);
			if (packageFile == null) return;
			const dependencies = await this.resolve(src, v);

			const vals: string[] = [];
			console.trace();
			for (let [pkg, info] of dependencies.entries()) {
				const base = this.libDir + `/${pkg}`;
				const strippedName = pkg.slice(0, pkg.lastIndexOf("@"));
				this._settings.downloadedNpmLibs[strippedName] = {
					baseDir: base,
					files: info.files.map((a) => this.computeBase(a, base)),
					entryPoint: info.entryPoint,
				};
				await this.app.vault.adapter.mkdir(base);
				for (const f of info.files) {
					const dirs = f.name.split("/").slice(1);
					dirs.pop();
					const rname = f.name.split("/").slice(1).join("/");
					const final = base + "/" + rname;
					const transformed = (() => {
						const decoder = new TextDecoder("utf-8");
						return decoder.decode(f.buffer);
					})();
					try {
						/* transform(text, {
							filename: final,
							sourceRoot: this.app.vault.adapter.getBasePath(),
							cwd: base,
							plugins: [
								[
									transformImportsAndExports,
									{
										vaultRoot: this.app.vault.adapter.getBasePath(),
										vaultFiles: this.app.vault.getFiles().map((a) => a.path),
										outerBaseDir: base,
										importPaths: Object.fromEntries(
											[...dependencies.entries()].map(([k, vv]) => {
												const base = this.libDir + `/${k}`;
												console.log("base = ", base);
												return [
													(() => {
														const s = k.split("@");
														s.pop();
														return s.join("@");
													})(),
													{
														vaultRoot: this.app.vault.adapter.getBasePath(),
														baseDir: base,
														files: vv.files.map((a) =>
															this.computeBase(a, base)
														),
														entryPoint: vv.entryPoint,
													},
												];
											})
										),
									},
								],	
							],
						})?.code! */ try {
							await this.app.vault.createFolder(base + "/" + dirs.join("/"));
						} catch (e) {}
						try {
							await this.app.vault.create(base + "/" + rname, transformed);
						} catch (e) {
							await this.app.vault.adapter.remove(base + "/" + rname);
							await this.app.vault.create(base + "/" + rname, transformed);
						}
						vals.push(final);
					} catch (ex) {
						console.error(ex);
						console.trace();
					}
				}
			}
		}
	}
	#getEsmFiles(tarFiles: TarFile[]) {
		return tarFiles.filter(
			(a) =>
				a.buffer.byteLength &&
				(a.name.endsWith(".mjs") || a.name.split(".").includes("esm")) &&
				a.name.endsWith("js")
		);
	}

	onunload() {
		this.saveSettings();
	}

	async loadSettings() {
		this._settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this._settings);
	}
}
