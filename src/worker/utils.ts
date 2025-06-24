import pathutils from "@chainner/node-path"
import { Archive, TarEntry } from "@obsidize/tar-browserify";
import pako from "pako";
import { exts } from "../util";

export function computeBase(f: TarEntry, base: string): string {
	const rname = f.fileName
		.split("/")
		.slice(f.fileName.startsWith("package/") ? 1 : 0)
		.join("/");
	return base + "/" + rname;
}
export async function getPackage(
	this: void,
	pkg: string,
	version: string
): Promise<{
	files: TarEntry[];
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
				const extracted = await Archive.extract(unzipped);
				return await Promise.all(extracted.entries);
			}),
	};
}
export async function resolve(
	this: void,
	pkg: string,
	v = "latest"
): Promise<{
	rootEntry: {
		version: string;
		entryPoint: string;
	};
	map: Map<string, { files: TarEntry[]; version: string; entryPoint: string }>;
}> {
	const queue: [string, string][] = [[pkg, v]];
	let visited = new Map<
		string,
		{ files: TarEntry[]; version: string; entryPoint: string }
	>();
	let rootEntry: { version: string; entryPoint: string };
	while (queue.length > 0) {
		let [cur, version] = queue.shift()!;
		if (!visited.has(`${cur}@${version}`)) {
			const { files: tar, realVersion } = await getPackage(cur, version);
			const packageFile = tar.find((a) =>
				a.fileName.startsWith("package/package.json")
			);
			if (!packageFile) continue;
			const packageJson = ((s: TarEntry) => {
				const decoder = new TextDecoder("utf-8");
				try {
					return JSON.parse(decoder.decode(s.content!));
				} catch (ex) {
					return null;
				}
			})(packageFile);
			if (!packageJson) continue;
			const modFiles: TarEntry[] = [];	
			
			modFiles.push(...tar);
			if (cur == pkg) {
				rootEntry = { entryPoint: packageJson.module, version: realVersion };
			}
			visited.set(`${cur}@${realVersion}`, {
				version: packageJson.version,
				entryPoint: packageJson.module,
				files: modFiles
					.filter(
						(it, i, a) => a.findIndex((b) => b.fileName == it.fileName) == i
					)
					.filter(
						(a) =>
							exts.includes(pathutils.extname(a.fileName)) &&
							!a.fileName.endsWith("map") &&
							// !a.fileName.includes("cjs") &&
							a.content?.byteLength
					),
			});
			queue.push(
				...Object.entries<string>(packageJson.dependencies ?? {}).map(
					([kk, vv]) => [kk, vv.replace(/[~\^\*]/gm, "")] as [string, string]
				)
			);
		}
	}
	return {
		map: visited,
		rootEntry: rootEntry!,
	};
}
