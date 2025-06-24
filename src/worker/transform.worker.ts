import { WorkerRequest, WorkerResponse } from "./types";
import { transform } from "@babel/core";
import { transformImportsAndExports } from "../util";
import { computeBase, resolve } from "./utils";
const stripName = (k: string) => {
	const lio = k.lastIndexOf("@");
	if (lio > 0) {
		return k.substring(0, lio);
	}
	return k;
};
onmessage = async (e) => {
	const {
		libDir,
		package: paackage,
		version,
		vaultRoot,
		vaultFiles,
		id,
	} = e.data as WorkerRequest;
	const { rootEntry, map: resolved } = await resolve(paackage, version);
	const finalFiles: WorkerResponse["content"] = {};
	for (let [pkg, info] of resolved.entries()) {
		const base = libDir + `/${pkg}`;
		const strippedName = stripName(pkg);
		/* this._settings.downloadedNpmLibs[strippedName] = {
			baseDir: base,
			files: info.files.map((a) => this.computeBase(a, base)),
			entryPoint: info.entryPoint,
		};
		await this.app.vault.adapter.mkdir(base); */
		const pkgEntry: WorkerResponse["content"][string]["files"] = [];
		for (const f of info.files) {
			const rname = f.fileName.split("/").slice(1).join("/");
			const final = base + "/" + rname;
			if (/emotion/i.test(strippedName)) console.log(strippedName, final);
			const text = (() => {
				const decoder = new TextDecoder("utf-8");
				return decoder.decode(f.content!);
			})();
			if (text.split("\n")[0].match(/@flow/i)) continue;
			try {
				const transformed = transform(text, {
					filename: final,
					sourceRoot: vaultRoot,
					cwd: vaultRoot,
					plugins: [
						[
							transformImportsAndExports,
							{
								vaultRoot: vaultRoot,
								vaultFiles,
								outerBaseDir: base,
								importPaths: Object.fromEntries(
									[...resolved.entries()].map(([k, vv]) => {
										const base = `${libDir}/${k}`;
										return [
											stripName(k),
											{
												vaultRoot: vaultRoot,
												baseDir: base,
												files: vv.files.map((a) => computeBase(a, base)),
												entryPoint: vv.entryPoint,
											},
										];
									})
								),
							},
						],
					],
				})!.code!;
				pkgEntry.push({
					path: base + "/" + rname,
					transformed,
				});
			} catch (e) {
				continue;
			}
		}
		finalFiles[strippedName] = {
			entryPoint: info.entryPoint,
			baseDir: base,
			files: pkgEntry,
		};
	}
	const msg: WorkerResponse = {
		id,
		package: paackage,
		version: rootEntry.version,
		content: finalFiles,
	};
	postMessage(msg);
};
