import jscodeshift from "jscodeshift";
import type { ASTPath, JSCodeshift } from "jscodeshift";
import type { namedTypes as N } from "ast-types";
import pathutils from "@chainner/node-path";

export type ImportArray = (
	| N.ImportSpecifier
	| N.ImportDefaultSpecifier
	| N.ImportNamespaceSpecifier
)[];
export type ExportArray = (N.ExportDefaultDeclaration | N.ExportNamedDeclaration)[];

type TransformContext = {
	j: JSCodeshift;
	dc: N.Identifier;
	dcJsx: N.JSXIdentifier;
	dcRequire: N.Identifier;
};

const createTransformContext = (j: JSCodeshift): TransformContext => ({
	j,
	dc: j.identifier("dc"),
	dcJsx: j.jsxIdentifier("dc"),
	dcRequire: j.identifier("require"),
});

export const exts = [
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".d.ts",
	"package.json",
];
export interface TransformOptions {
	vaultFiles: string[];
	vaultRoot: string;
	outerBaseDir: string;
	isSecondPass?: boolean;
	version?: string;
	importPaths: {
		[k: string]: {
			baseDir: string;
			files: string[];
			entryPoint: string;
			dependencies: string[];
			latest: string;
		};
	};
	dependencies: string[];
	latestVersions: {
		[k: string]: string;
	};
}
export interface TransformRequest {
	possiblePaths: string[];
}

export const stripName = (k: string) => {
	const lio = k.lastIndexOf("@");
	if (lio > 0) {
		return k.substring(0, lio);
	}
	return k;
};

const dcMember = (ctx: TransformContext, ident: N.Identifier) =>
	ctx.j.memberExpression(ctx.dc, ident);
const mustIdent = (ctx: TransformContext, item: N.Node): N.Identifier => {
	const n = ctx.j.types.namedTypes;
	if (n.StringLiteral.check(item)) {
		return ctx.j.identifier((item as N.StringLiteral).value);
	}
	if (n.Identifier.check(item)) return item as N.Identifier;
	if (n.JSXIdentifier.check(item))
		return ctx.j.identifier((item as N.JSXIdentifier).name);
	return item as unknown as N.Identifier;
};
function replaceWithIdent(
	ctx: TransformContext,
	specs: ImportArray | N.ExportSpecifier[],
	src: N.Expression
) {
	const n = ctx.j.types.namedTypes;
	const specList = specs as Array<ImportArray[number] | N.ExportSpecifier>;
	const isImportSpecifier = (
		item: ImportArray[number] | N.ExportSpecifier
	): item is N.ImportSpecifier => n.ImportSpecifier.check(item as N.Node);
	const isExportSpecifier = (
		item: ImportArray[number] | N.ExportSpecifier
	): item is N.ExportSpecifier => n.ExportSpecifier.check(item as N.Node);
	let mappedSpecs = specList
		.filter(
			(s) =>
				(isImportSpecifier(s) &&
					mustIdent(ctx, (s as N.ImportSpecifier).imported).name !=
						"default") ||
				(isExportSpecifier(s) &&
					mustIdent(
						ctx,
						((s as N.ExportSpecifier).local ?? ctx.j.identifier("default")) as N.Node
					).name != "default")
		)
		.map((s) => {
			let i: N.Identifier;
			if (isExportSpecifier(s)) i = mustIdent(ctx, s.exported);
			else i = mustIdent(ctx, (s as N.ImportSpecifier).imported);
			const local = (s as N.ImportSpecifier | N.ExportSpecifier).local ?? i;
			const prop = ctx.j.objectProperty(i, local as N.Identifier);
			prop.shorthand = i.name == (local as N.Identifier).name;
			return prop;
		});

	let defaults = specList
		.filter(
			(s) =>
				n.ImportNamespaceSpecifier.check(s as N.Node) ||
				n.ImportDefaultSpecifier.check(s as N.Node) ||
				(isExportSpecifier(s) &&
					mustIdent(ctx, (s as N.ExportSpecifier).exported as N.Node).name ==
						"default")
		)
		.map(
			(s) =>
				(s as
					| N.ImportSpecifier
					| N.ImportDefaultSpecifier
					| N.ImportNamespaceSpecifier
					| N.ExportSpecifier).local!
		);
	let destructuredDefaultImports = specList.filter(
		(s) =>
			isImportSpecifier(s) &&
			mustIdent(ctx, (s as N.ImportSpecifier).imported as N.Node).name ==
				"default"
	) as N.ImportSpecifier[];
	let destructuredDefaultExports = specList.filter(
		(s) =>
			isExportSpecifier(s) &&
			mustIdent(
				ctx,
				((s as N.ExportSpecifier).local ?? ctx.j.identifier("default")) as N.Node
			).name == "default"
	) as N.ExportSpecifier[];
	let mappedDefaults = defaults.map((m) =>
		ctx.j.variableDeclarator(m, src as any)
	);
	let declarators: N.VariableDeclarator[] = [];
	declarators.push(
		...destructuredDefaultImports.map((a) =>
			ctx.j.variableDeclarator(a.local as any, src as any)
		)
	);
	declarators.push(
		...destructuredDefaultExports.map((a) =>
			ctx.j.variableDeclarator(mustIdent(ctx, a.exported) as any, src as any)
		)
	);
	if (mappedSpecs.length)
		declarators.push(
			ctx.j.variableDeclarator(ctx.j.objectPattern(mappedSpecs), src as any)
		);
	declarators.push(...mappedDefaults);
	return declarators.length
		? ctx.j.variableDeclaration("const", declarators)
		: ctx.j.expressionStatement(src as any);
}

function replaceJsxElement(
	ctx: TransformContext,
	path: ASTPath<N.JSXOpeningElement | N.JSXClosingElement>,
	dcImports: N.ImportSpecifier[]
) {
	const n = ctx.j.types.namedTypes;
	const node = path.node;
	const nname = node.name as N.JSXIdentifier;
	if (
		dcImports.find(
			(a) => n.Identifier.check(a.imported) && a.imported.name == nname.name
		)
	) {
		let me = ctx.j.jsxMemberExpression(
			ctx.dcJsx,
			ctx.j.jsxIdentifier(nname.name)
		);
		return me;
	}
	return null;
}
function convertImportToDcRequire(
	ctx: TransformContext,
	src: string | N.StringLiteral
) {
	const n = ctx.j.types.namedTypes;
	const finalSource =
		typeof src != "string" && n.StringLiteral.check(src)
			? src
			: ctx.j.stringLiteral(src as string);
	return ctx.j.awaitExpression(
		ctx.j.callExpression(ctx.j.memberExpression(ctx.dc, ctx.dcRequire), [
			finalSource,
		])
	);
}
function declToObjectProperty(
	ctx: TransformContext,
	decl: N.Declaration | null
): N.ObjectProperty[] {
	const n = ctx.j.types.namedTypes;
	if (decl == null) return [];
	if (n.VariableDeclaration.check(decl)) {
		const varDecl = decl as N.VariableDeclaration;
		return varDecl.declarations.map((a) => {
			const rid =n.Identifier.check(a) || n.JSXIdentifier.check(a) || n.TSTypeParameter.check(a) ? a :a.id; 
			const rinit = n.VariableDeclarator.check(a) ? a.init : rid;
			let prop = ctx.j.objectProperty(
				rid as N.Identifier,
				rinit ?? rid
			);
			prop.shorthand = true;
			return prop;
		});
	} else if (n.FunctionDeclaration.check(decl)) {
		const fnDecl = decl as N.FunctionDeclaration;
		let prop = ctx.j.objectProperty(fnDecl.id!, fnDecl.id!);
		prop.shorthand = true;
		return [prop];
	}
	return [];
}

function convertExports(
	ctx: TransformContext,
	exports: ExportArray,
	opts: TransformOptions,
	filename?: string
) {
	const n = ctx.j.types.namedTypes;
	let singleDefault: N.Expression | null = null;
	const objEx = ctx.j.objectExpression(
		exports
			.flatMap<N.ObjectProperty | N.SpreadElement | null>((e) => {
				if (n.ExportNamedDeclaration.check(e)) {
					const namedDecl = e as N.ExportNamedDeclaration;
					if (Array.isArray(namedDecl.specifiers) && namedDecl.specifiers?.length) {
						return (
							namedDecl.specifiers as (
								| N.ExportSpecifier
								| N.ExportNamespaceSpecifier
								| N.ExportDefaultSpecifier
							)[]
						).map((a) => {
							if (n.ExportNamespaceSpecifier.check(a)) {
								const convertedSource = convertRelative(
									(namedDecl.source as N.StringLiteral).value,
									opts,
									filename
								);
								return ctx.j.objectProperty(
									a.exported,
									convertImportToDcRequire(
										ctx,
										ctx.j.stringLiteral(convertedSource!)
									)
								);
							} else if (n.ExportSpecifier.check(a)) {
								const exportSpec = a as N.ExportSpecifier;
								if ((exportSpec.exported as N.Identifier).name == "default") {
									singleDefault = exportSpec.local as N.Identifier;
									return null;
								}
								return ctx.j.objectProperty(
									exportSpec.exported,
									exportSpec.local ?? exportSpec.exported
								);
							}
							return null;
						});
					} else if (declToObjectProperty(ctx, namedDecl.declaration!).length) {
						return declToObjectProperty(ctx, namedDecl.declaration!);
					}
				} else {
					const defaultDecl = e as N.ExportDefaultDeclaration;
					if (!singleDefault)
						singleDefault = defaultDecl.declaration as N.Expression;
				}
				return [];
			})
			.filter((a) => !!a)
	);
	const sd = singleDefault as any;
	if (sd) {
		if (n.FunctionDeclaration.check(sd) || n.VariableDeclaration.check(sd)) {
			if (n.FunctionDeclaration.check(sd)) {
				return ctx.j.returnStatement(
					ctx.j.functionExpression(
						sd.id,
						sd.params,
						sd.body,
						sd.generator,
						sd.async
					)
				);
			}
			return ctx.j.returnStatement(singleDefault as any);
		} else if (n.Expression.check(sd)) {
			return ctx.j.returnStatement(singleDefault as any);
		}
	}
	const rs = ctx.j.returnStatement(objEx);
	return rs;
}

const sep_regex = /\/|\\/;
function convertRelative(
	src: string,
	opts: TransformOptions,
	filename?: string
) {
	const { importPaths, version, dependencies: deps } = opts;
	let ext = pathutils.extname(filename!)
	if(ext == ".ts" && filename?.endsWith(".d.ts")) {
		ext = ".d.ts"
		// ext = ".js"
	}
	if (
		filename &&
		(pathutils.isAbsolute(filename) || pathutils.win32.isAbsolute(filename))
	)
		filename = filename
			.split(sep_regex)
			.slice(filename.split(sep_regex).indexOf(".obsidian"))
			.join("/");
	let base = src;
	let key = `${base}@${version}`;
	let aux: string | null = null;
	if (
		src.split("/").length > 2 &&
		!src.startsWith("./") &&
		!src.startsWith("..")
	) {
		base = src.split("/").slice(0, 2).join("/");
		key = `${base}@${version}`;
		if (!importPaths[key]) key = deps.find((a) => a.startsWith(base))!;
		aux = src.split("/").slice(2).join("/");
	}
	if (!importPaths[key] && !src.startsWith("./") && !src.startsWith("..")) {
		let nk = deps.find((a) => {
			return a.startsWith(base);
		});
		if (nk) key = nk;
		else key = `${base}@${opts.latestVersions[base]}`;
	}
	if(!aux && importPaths[key]?.entryPoint) {
		return pathutils.posix.join(importPaths[key].baseDir,importPaths[key].entryPoint)
	}

	let entry: string | undefined = importPaths[key]?.files?.find(
		(a) =>
			a.endsWith(importPaths[key].entryPoint) &&
			!a.includes("cjs") &&
			exts.includes(pathutils.extname(a))
	);
	if (aux) {
		const split = aux.split("/");
		/* entry = importPaths[key]?.files?.map((a) => {
			return [a, aux
				.split("/")
				.filter(
					(b, i, arr) =>
						exts.some((c) => a.endsWith(b + c)) || a.includes(`/${b}/`) || a.includes(`${b}/`)
				).length] as [string, number];
		}).reduce((pv, cv) => pv[1] <= cv[1] ? cv : pv, ["", 0])[0]; */
		const lastSegment = split[split.length - 1];
		const rest = split.slice(0, -1);
		entry = importPaths[key]?.files?.find(a => exts.some(b => a.endsWith(lastSegment + b)) && rest.every(b => a.includes(`/${b}/`)))
	}
	if ((src.startsWith("./") || src.startsWith("..")) && filename) {
		entry = pathutils
			.join(pathutils.dirname(filename), src)
			.replace(/\\/g, "/");

		if (!exts.includes(pathutils.extname(entry))) {
			const tmp = entry.replace(/\\/g, "/");
			let splitDir = pathutils.dirname(tmp).split(/\/|\\/);	
			let chopped = splitDir.slice(splitDir.indexOf("libs") + 1);
			if(!chopped.length) {
				chopped = splitDir;
			}

			// scuffed sliding window algorithm i guess..?
			let libName: string | null = null;
			outer: for (let i = 0; i < chopped.length; i++) {
				for (let j = 1; j <= 2; j++) {
					const libStart = chopped.slice(0, j).join("/");
					if (
						libStart in importPaths
					) {
						libName = libStart;
						break outer;
					}
				}
			}
			if (libName && (key.startsWith("./") || key.startsWith(".."))) {
				key = libName;
			}

			entry = importPaths[libName!]?.files?.find(
				(a) =>
					 a != filename && a == pathutils.posix.normalize(tmp + ext)
			);

			if (!entry) {
				console.warn("undefined relative entry ->", src, `(${filename})`);
			}
		}
	}
	if (!entry)
		entry =
			importPaths[key] && importPaths[key].entryPoint
				? importPaths[key]?.baseDir + "/" + importPaths[key]?.entryPoint
				: undefined;
	if (!entry && importPaths[key]?.files?.length == 1) {
		entry = importPaths[key].files[0];
	}
	if (!entry) {
		if (aux) {
			entry = importPaths[key]?.files?.find((a) =>
				aux
					.split("/")
					.every(
						(b, i, arr) =>
							exts.some((c) => a.endsWith(b + c)) || a.includes(`${b}/`)
					)
			);
		}
	}
	if (!entry) {
		entry = importPaths[key]?.files?.find(
			(a) => a.endsWith("index.js") && !a.includes("cjs")
		);
	}
	return entry;
}
type ImportConvertResult = {
	hooks: N.ImportSpecifier[];
	otherReact: ImportArray;
	specs: N.Statement[];
	dcImports: N.ImportSpecifier[];
	shouldRemove: boolean;
};
function convertRequireCallToImport(
	ctx: TransformContext,
	node: N.VariableDeclaration | N.AssignmentExpression
): [mod: string, specs: ImportArray][] {
	const n = ctx.j.types.namedTypes;
	const ret: [string, ImportArray][] = [];
	if (n.VariableDeclaration.check(node)) {
		const varDecl = node as N.VariableDeclaration;
		for (let d of varDecl.declarations as N.VariableDeclarator[]) {
			if (!d.init || !n.CallExpression.check(d.init)) continue;
			const init = d.init as N.CallExpression;
			if (
				n.Identifier.check(init.callee) &&
				(init.callee as N.Identifier).name == "require"
			) {
				let mod = (init.arguments[0] as N.StringLiteral).value;
				let specs: ImportArray = [];
				if (n.ObjectPattern.check(d.id)) {
					const objPattern = d.id as N.ObjectPattern;
					for (let p of objPattern.properties) {
						if (n.RestElement.check(p)) {
						} else {
							const prop = p as N.ObjectProperty;
							specs.push(
								ctx.j.importSpecifier(
									prop.value as N.Identifier,
									prop.key as N.Identifier
								)
							);
						}
					}
				} else if (n.Identifier.check(d.id)) {
					specs.push(ctx.j.importDefaultSpecifier(d.id as N.Identifier));
				}
				ret.push([mod, specs]);
			}
		}
	} /* else if (t.isAssignmentExpression(node)) {
		if (t.isIdentifier(node.left)) {
			ret.specs.push(b.importDefaultSpecifier(node.left));
		} 
	}*/
	return ret;
}
function convertImportOrRequire(
	ctx: TransformContext,
	src: string,
	specifiers: ImportArray = [],
	opts: TransformOptions,
	filename?: string
): ImportConvertResult {
	const n = ctx.j.types.namedTypes;
	const isImportSpecifier = (item: any): item is N.ImportSpecifier =>
		n.ImportSpecifier.check(item as N.Node);
	const isIdentifier = (item: any): item is N.Identifier =>
		n.Identifier.check(item as N.Node);
	let specs: ImportConvertResult = {
		hooks: [],
		otherReact: [],
		specs: [],
		dcImports: [],
		shouldRemove: false,
	};
	if (["react", "preact", "preact/hooks", "preact/compat"].includes(src)) {
		let hooks = specifiers.filter(
			(s): s is N.ImportSpecifier =>
				isImportSpecifier(s) &&
				isIdentifier(s.imported) &&
				s.imported.name.startsWith("use")
		);
		let other: ImportArray = specifiers.filter(
			(
				s: N.ImportSpecifier | N.ImportDefaultSpecifier | N.ImportNamespaceSpecifier
			) =>
				(isImportSpecifier(s) &&
					isIdentifier(s.imported) &&
					!s.imported.name.startsWith("use")) ||
				n.ImportDefaultSpecifier.check(s) ||
				n.ImportNamespaceSpecifier.check(s)
		) as ImportArray;
		specs.hooks.push(...hooks);
		/* let hookSpecs = replaceWithIdent(
					hooks,
					dcMember(b.identifier("hooks"))
				); */
		let otherSpecs = replaceWithIdent(
			ctx,
			specifiers,
			dcMember(ctx, ctx.j.identifier("preact"))
		);
		const finalReplacement: (N.VariableDeclaration | N.ExpressionStatement)[] = [];
		// if (hookSpecs.declarations.length) finalReplacement.push(hookSpecs);
		finalReplacement.push(otherSpecs);
		specs.specs = finalReplacement;
	} else if (src == "react-dom") {
		specs.specs = [
			replaceWithIdent(
				ctx,
				specifiers as ImportArray,
				dcMember(ctx, ctx.j.identifier("preact"))
			),
		];
	} else if (src.startsWith("react/jsx-")) {
		specs.specs = [
			replaceWithIdent(
				ctx,
				specifiers as ImportArray,
				dcMember(ctx, ctx.j.identifier("jsxRuntime"))
			),
		];
	} else if (src === "#datacore") {
		specs.dcImports.push(...(specifiers as N.ImportSpecifier[]));
		specs.shouldRemove = true;
	} else if (
		opts.vaultFiles.find((a) => a.startsWith(src)) ||
		src.includes("#") ||
		src.includes("^")
	) {
		const awaiter = ctx.j.awaitExpression(
			ctx.j.callExpression(ctx.j.memberExpression(ctx.dc, ctx.dcRequire), [
				ctx.j.stringLiteral(src),
			])
		);
		specs.specs = [replaceWithIdent(ctx, specifiers as ImportArray, awaiter)];
	} else {
		let entry = convertRelative(src, opts, filename);
		if (entry) {
			const awaiter = ctx.j.awaitExpression(
				ctx.j.callExpression(ctx.j.memberExpression(ctx.dc, ctx.dcRequire), [
					ctx.j.stringLiteral(entry!),
				])
			);
			specs.specs = [
				replaceWithIdent(ctx, specifiers as ImportArray, awaiter),
			];
		} else {
			specs.shouldRemove = true;
		}
	}
	return specs;
}

export function transformImportsAndExports(
	source: string,
	opts: TransformOptions,
	filename?: string
): string {
	const j = jscodeshift.withParser("tsx");
	const ctx = createTransformContext(j);
	const n = j.types.namedTypes;
	const isIdentifier = (node: any): node is N.Identifier =>
		n.Identifier.check(node as N.Node);
	const isStringLiteral = (node: any): node is N.StringLiteral =>
		n.StringLiteral.check(node as N.Node);
	const isMemberExpression = (node: any): node is N.MemberExpression =>
		n.MemberExpression.check(node as N.Node);
	const isOptionalMemberExpression = (
		node: any
	): node is N.OptionalMemberExpression =>
		n.OptionalMemberExpression.check(node as N.Node);
	const isObjectProperty = (node: any): node is N.ObjectProperty =>
		n.ObjectProperty.check(node as N.Node);
	const root = j(source);
	let dcImports: N.ImportSpecifier[] = [];
	let dcHooks: N.ImportSpecifier[] = [];
	let dcExports: ExportArray = [];
	let allDecls: N.ExportAllDeclaration[] = [];

	root.find(j.ImportDeclaration).forEach((path: ASTPath<N.ImportDeclaration>) => {
		const node = path.node;
		const src = String(node.source.value);
		const res = convertImportOrRequire(
			ctx,
			src,
			node.specifiers as ImportArray,
			opts,
			filename
		);
		dcImports.push(...res.dcImports);
		dcHooks.push(...res.hooks);
		if (res.shouldRemove) {
			j(path).remove();
		} else if (res.specs.length) {
			path.replace(...res.specs);
		} else {
			j(path).remove();
		}
	});

	root.find(j.ExpressionStatement).forEach(
		(path: ASTPath<N.ExpressionStatement>) => {
		const node = path.node;
		if (n.CallExpression.check(node.expression)) {
			const callExpr = node.expression as N.CallExpression;
			const args = callExpr.arguments;
			if (
				n.MemberExpression.check(callExpr.callee) &&
				args.length == 3 &&
				isIdentifier(args[0]) &&
				args[0].name == "exports"
			) {
			const ident = mustIdent(
				ctx,
				callExpr.arguments[1] as N.StringLiteral
			);
			let value: N.ExpressionStatement | null = null;
			if (ident.name != "__esModule") {
				const objEx = callExpr.arguments[2] as N.ObjectExpression;
				const val = objEx.properties.find((prop): prop is N.ObjectProperty => {
					if (!isObjectProperty(prop)) return false;
					const key = (prop as N.ObjectProperty).key;
					if (!isIdentifier(key)) return false;
					return key.name == "value" || key.name == "get";
				});
				if (val) {
					const key = val.key as N.Identifier;
					if (key.name == "value") {
						value = j.expressionStatement(val.value as any);
					} else if (key.name == "get") {
						const body = val.value as N.FunctionExpression;
						value = j.expressionStatement(
							j.callExpression(
								j.functionExpression(
									null,
									[],
									body.body,
									body.generator,
									body.async
								),
								[]
							)
						);
					}
					dcExports.push(
						j.exportNamedDeclaration(
							j.variableDeclaration("const", [
								j.variableDeclarator(ident, value?.expression),
							])
						)
					);
				}
				j(path).remove();
			} else {
				j(path).remove();
			}
			}
		}
	});

	root.find(j.VariableDeclaration).forEach(
		(path: ASTPath<N.VariableDeclaration>) => {
		const node = path.node;
		const res = convertRequireCallToImport(ctx, node);
		if (res.length) {
			path.replace(
				...res.map(([mod, specs]) =>
					j.importDeclaration(specs, j.stringLiteral(mod))
				)
			);
		}
	});

	root.find(j.CallExpression).forEach((path: ASTPath<N.CallExpression>) => {
		const node = path.node;
		const calleeIdent = isIdentifier(node.callee) ? node.callee : null;
		if (
			calleeIdent &&
			(dcImports.find(
				(a) =>
					n.Identifier.check(a.imported) &&
					a.imported.name == calleeIdent.name
			) != null ||
				dcHooks.find(
					(a) =>
						n.Identifier.check(a.imported) &&
						a.imported.name == calleeIdent.name
				) != null)
		) {
			const nm = j.memberExpression(ctx.dc, calleeIdent);
			path.replace(j.callExpression(nm, node.arguments));
		} else if (
			isIdentifier(node.callee) &&
			node.callee.name == "require" &&
			isStringLiteral(node.arguments[0])
		) {
			let entry = convertRelative(
				(node.arguments[0] as N.StringLiteral).value,
				opts,
				filename
			);
			if (entry) {
				const awaiter = j.awaitExpression(
					j.callExpression(j.memberExpression(ctx.dc, ctx.dcRequire), [
						j.stringLiteral(entry!),
					])
				);
				path.replace(awaiter);
			}
		}
	});

	root.find(j.AssignmentExpression).forEach(
		(path: ASTPath<N.AssignmentExpression>) => {
		const node = path.node;
		const isModuleExports = (
			target: N.Node | null | undefined
		): target is N.MemberExpression | N.OptionalMemberExpression => {
			if (!target) return false;
			if (isMemberExpression(target)) {
				if (isIdentifier(target.property) && isIdentifier(target.object)) {
					return (
						target.object.name == "module" &&
						target.property.name == "exports"
					);
				} else if (isMemberExpression(target.object)) {
					return isModuleExports(target.object);
				}
			} else if (isOptionalMemberExpression(target)) {
				if (isIdentifier(target.property) && isIdentifier(target.object)) {
					return (
						target.object.name == "module" &&
						target.property.name == "exports"
					);
				} else if (
					isOptionalMemberExpression(target.object) ||
					isMemberExpression(target.object)
				) {
					return isModuleExports(target.object);
				}
			}
			return false;
		};
		const isExports = (
			target: N.Node | null | undefined
		): target is N.MemberExpression | N.OptionalMemberExpression => {
			if (!target) return false;
			if (isMemberExpression(target)) {
				if (isIdentifier(target.property) && isIdentifier(target.object)) {
					return target.object.name == "exports";
				}
			} else if (isOptionalMemberExpression(target)) {
				if (isIdentifier(target.property) && isIdentifier(target.object)) {
					return target.object.name == "exports";
				}
			}
			return false;
		};
		if (isModuleExports(node.left)) {
			let me = node.left as N.MemberExpression;
			if (isMemberExpression(me.object) && isIdentifier(me.object.property)) {
				const prop = isIdentifier(me.property)
					? me.property
					: j.identifier((me.property as N.StringLiteral).value);
				const vd = j.variableDeclaration("const", [
					j.variableDeclarator(prop, node.right as any),
				]);
				const final = j.exportNamedDeclaration(vd);
				dcExports.push(final);
				j(path).remove();
			} else {
				const final = j.exportDefaultDeclaration(node.right as any);
				dcExports.push(final);
				const parent = path.parentPath ?? path.parent;
				if (
					parent &&
					(n.ExpressionStatement.check(parent.node) ||
						n.AssignmentExpression.check(parent.node) ||
						n.ConditionalExpression.check(parent.node))
				) {
					j(parent).remove();
				} else {
					j(path).remove();
				}
			}
		} else if (isExports(node.left)) {
			let me = node.left as N.MemberExpression;
			const prop = isIdentifier(me.property)
				? me.property
				: j.identifier((me.property as N.StringLiteral).value);
			const vd = j.variableDeclaration("const", [
				j.variableDeclarator(prop, node.right as any),
			]);
			const final = j.exportNamedDeclaration(vd);
			dcExports.push(final);

			const parent = path.parentPath ?? path.parent;
			if (
				parent &&
				(n.ExpressionStatement.check(parent.node) ||
					n.AssignmentExpression.check(parent.node) ||
					n.ConditionalExpression.check(parent.node) ||
					n.ObjectProperty.check(parent.node))
			) {
				if (n.ObjectProperty.check(parent.node)) {
					path.replace(j.nullLiteral());
				} else {
					parent.replace(j.expressionStatement(j.nullLiteral()));
				}
			} else {
				j(path).remove();
			}
		}
	});

	root.find(j.JSXOpeningElement).forEach(
		(path: ASTPath<N.JSXOpeningElement>) => {
		let toReplace = replaceJsxElement(ctx, path, dcImports);
		if (toReplace)
			path.replace(
				j.jsxOpeningElement(toReplace, path.node.attributes, path.node.selfClosing)
			);
	});

	root.find(j.JSXClosingElement).forEach(
		(path: ASTPath<N.JSXClosingElement>) => {
		let toReplace = replaceJsxElement(ctx, path, dcImports);
		if (toReplace) path.replace(j.jsxClosingElement(toReplace));
	});

	root.find(j.ExportNamedDeclaration).forEach(
		(path: ASTPath<N.ExportNamedDeclaration>) => {
		const node = path.node;
		if (node.declaration) {
			dcExports.push(node);
			path.replace(node.declaration);
		} else {
			const specifiers = node.specifiers ?? [];
			if (node.source && specifiers.length) {
				const entry = convertRelative(String(node.source.value), opts, filename);
				if (entry) {
				const awaiter = j.awaitExpression(
					j.callExpression(j.memberExpression(ctx.dc, ctx.dcRequire), [
						j.stringLiteral(entry!),
					])
				);
				const specs = replaceWithIdent(
					ctx,
					specifiers as N.ExportSpecifier[],
					awaiter
				);
				const exportSpecifiers = n.VariableDeclaration.check(specs)
					? (specs as N.VariableDeclaration).declarations.flatMap(
							(a) => {
							const fin: N.ExportSpecifier[] = [];

							if (n.Identifier.check(a)) {
								fin.push(j.exportSpecifier(a, a));
							} else if (n.VariableDeclarator.check(a) && n.ObjectPattern.check(a.id)) {
								const objPattern = a.id as N.ObjectPattern;
								fin.push(
									...objPattern.properties.flatMap((b: any) => {
										if (
											n.ObjectProperty.check(b as N.Node) &&
											n.Identifier.check((b as N.ObjectProperty).value) &&
											(n.Identifier.check((b as N.ObjectProperty).key) ||
												n.StringLiteral.check((b as N.ObjectProperty).key))
										) {
											return [
												j.exportSpecifier(
													(b as N.ObjectProperty).value as any,
													(b as N.ObjectProperty).key as any
												),
											];
										}
										return [];
									})
								);
							}
							return fin;
						}
						)
					: [];
				dcExports.push(j.exportNamedDeclaration(null, exportSpecifiers));
					path.replace(specs);
				} else {
					dcExports.push(node);
					j(path).remove();
				}
			} else {
				dcExports.push(node);
				j(path).remove();
			}
		}
	});

	root.find(j.ExportAllDeclaration).forEach(
		(path: ASTPath<N.ExportAllDeclaration>) => {
		allDecls.push(path.node);
		j(path).remove();
	});

	root.find(j.ExportDefaultDeclaration).forEach(
		(path: ASTPath<N.ExportDefaultDeclaration>) => {
		const node = path.node;
		dcExports.push(node);
		j(path).remove();
	});

	const originalExports = convertExports(
		ctx,
		dcExports.filter((a) => !(a as any).source),
		opts,
		filename
	);

	opts.isSecondPass = true;
	const aggregatedAll = j.objectExpression(
		allDecls.map((a) => {
			const convertedSource = convertRelative(
				String(a.source.value),
				opts,
				filename
			);
			if (convertedSource) {
				const spreads = j.spreadElement(
					convertImportToDcRequire(ctx, j.stringLiteral(convertedSource!))
				);
				return spreads;
			} else {
				return j.spreadElement(j.objectExpression([]));
			}
		})
	);
	if (originalExports.argument && n.ObjectExpression.check(originalExports.argument)) {
		(originalExports.argument as N.ObjectExpression).properties.push(
			...aggregatedAll.properties
		);
	}

	root.get().node.program.body.push(originalExports);
	return root.toSource();
}
