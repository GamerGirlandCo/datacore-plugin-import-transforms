import * as Babel from "@babel/core";
import * as babel from "@babel/core";
import syntaxJsx from "babel-plugin-syntax-jsx";
import syntaxTs from "babel-plugin-syntax-typescript";
import type {
	Declaration,
	ExportAllDeclaration,
	ExportDeclaration,
	ExportDefaultDeclaration,
	ExportDefaultSpecifier,
	ExportNamedDeclaration,
	ExportNamespaceSpecifier,
	ExportSpecifier,
	Expression,
	Identifier,
	ImportDeclaration,
	ImportDefaultSpecifier,
	ImportNamespaceSpecifier,
	ImportSpecifier,
	JSXClosingElement,
	JSXIdentifier,
	JSXOpeningElement,
	ObjectProperty,
	SpreadElement,
	StringLiteral,
	VariableDeclarator,
} from "@babel/types";
import * as t from "@babel/types";
import pathutils from "path-browserify-esm";
import { parse as doParse, parse, ParserPlugin } from "@babel/parser";
import { Vault } from "obsidian";
import DatacoreJSTransformPlugin from "./main";
import generate from "@babel/generator";
import { NodePath } from "@babel/traverse";
import { PluginObj, transformAsync } from "@babel/core";
const b = t;

export type ImportArray = (
	| ImportSpecifier
	| ImportDefaultSpecifier
	| ImportNamespaceSpecifier
)[];
export type ExportArray = (ExportDefaultDeclaration | ExportNamedDeclaration)[];

export interface TransformOptions {
	vaultFiles: string[];
	vaultRoot: string;
	outerBaseDir: string;
	importPaths: {
		[k: string]: {
			baseDir: string;
			files: string[];
			entryPoint: string;
		};
	};
}

export interface TransformRequest {
	possiblePaths: string[];
}

const dc = b.identifier("dc");
const dcJsx = b.jsxIdentifier("dc");
const dcRequire = b.identifier("require");

const dcMember = (ident: Identifier) => b.memberExpression(dc, ident);
const mustIdent = (item: StringLiteral | Identifier) => {
	if (t.isStringLiteral(item)) return t.identifier(item.value);
	else return item;
};
function replaceWithIdent(
	specs: ImportArray | ExportSpecifier[],
	src: Expression
) {
	let mappedSpecs = specs
		.filter(
			(s) =>
				(t.isImportSpecifier(s) && mustIdent(s.imported).name != "default") ||
				(t.isExportSpecifier(s) && mustIdent(s.local).name != "default")
		)
		.map((s: ImportSpecifier | ExportSpecifier) => {
			let i: Identifier;
			if (t.isExportSpecifier(s)) i = mustIdent(s.exported);
			else i = mustIdent(s.imported);
			const prop = b.objectProperty(i, s.local ?? i);
			prop.shorthand = i.name == s.local?.name;
			return prop;
		});

	let defaults = specs
		.filter(
			(s) =>
				t.isImportNamespaceSpecifier(s) ||
				t.isImportDefaultSpecifier(s) ||
				(t.isExportSpecifier(s) && mustIdent(s.exported).name == "default")
		)
		.map((s) => s.local!);
	let destructuredDefaultImports = specs.filter(
		(s) => t.isImportSpecifier(s) && mustIdent(s.imported).name == "default"
	) as ImportSpecifier[];
	let destructuredDefaultExports = specs.filter(
		(s) => t.isExportSpecifier(s) && mustIdent(s.local).name == "default"
	) as ExportSpecifier[];
	let mappedDefaults = defaults.map((m) => b.variableDeclarator(m, src));
	let declarators: VariableDeclarator[] = [];
	declarators.push(
		...destructuredDefaultImports.map((a) => b.variableDeclarator(a.local, src))
	);
	declarators.push(
		...destructuredDefaultExports.map((a) =>
			b.variableDeclarator(mustIdent(a.exported), src)
		)
	);
	if (mappedSpecs.length)
		declarators.push(b.variableDeclarator(b.objectPattern(mappedSpecs), src));
	declarators.push(...mappedDefaults);
	return declarators.length
		? b.variableDeclaration("const", declarators)
		: b.expressionStatement(src);
}

function replaceJsxElement(
	path: NodePath<JSXOpeningElement | JSXClosingElement>,
	dcImports: ImportSpecifier[]
) {
	const node = path.node;
	const nname = node.name as JSXIdentifier;
	if (
		dcImports.find(
			(a) => t.isIdentifier(a.imported) && a.imported.name == nname.name
		)
	) {
		let me = b.jsxMemberExpression(dcJsx, b.jsxIdentifier(nname.name));
		return me;
	}
	return null;
}
function convertImportToDcRequire(src: string | StringLiteral) {
	const finalSource =
		typeof src != "string" && t.isStringLiteral(src)
			? src
			: b.stringLiteral(src);
	return b.awaitExpression(
		b.callExpression(b.memberExpression(dc, dcRequire), [finalSource])
	);
}
function declToObjectProperty(decl: Declaration | null): ObjectProperty[] {
	if (decl == null) return [];
	if (t.isVariableDeclaration(decl)) {
		return decl.declarations.map((a) => {
			let prop = b.objectProperty(
				a.id as Identifier,
				(a.init ?? a.id) as Expression
			);
			prop.shorthand = true;
			return prop;
		});
	} else if (t.isFunctionDeclaration(decl)) {
		let prop = b.objectProperty(decl.id!, decl.id!);
		prop.shorthand = true;
		return [prop];
	}
	return [];
}

function convertExports(
	exports: ExportArray,
	outerBaseDir: string,
	importPaths: TransformOptions["importPaths"],
	filename?: string
) {
	let singleDefault: Expression | null = null;
	const objEx = b.objectExpression(
		exports
			.flatMap<ObjectProperty | SpreadElement | null>((e) => {
				if (t.isExportNamedDeclaration(e)) {
					if (Array.isArray(e.specifiers) && e.specifiers?.length) {
						return (
							e.specifiers as (
								| ExportSpecifier
								| ExportNamespaceSpecifier
								| ExportDefaultSpecifier
							)[]
						).map((a) => {
							if (t.isExportNamespaceSpecifier(a)) {
								const convertedSource = convertRelative(
									(e.source as StringLiteral).value,
									outerBaseDir,
									importPaths,
									filename
								);
								return b.objectProperty(
									a.exported,
									convertImportToDcRequire(b.stringLiteral(convertedSource!))
								);
							} else if (t.isExportSpecifier(a)) {
								if ((a.exported as Identifier).name == "default") {
									singleDefault = a.local!;
									return null;
								}
								return b.objectProperty(a.exported, a.local ?? a.exported);
							}
							return null;
						});
					} else if (declToObjectProperty(e.declaration!).length) {
						return declToObjectProperty(e.declaration!);
					}
				} else {
					if (!singleDefault) singleDefault = e.declaration as Expression;
				}
				return [];
			})
			.filter((a) => !!a)
	);
	const sd = singleDefault as any;
	if (sd) {
		if (t.isFunctionDeclaration(sd) || t.isVariableDeclaration(sd)) {
			if (t.isFunctionDeclaration(sd)) {
				return b.returnStatement(
					b.functionExpression(
						sd.id,
						sd.params,
						sd.body,
						sd.generator,
						sd.async
					)
				);
			}
			return b.returnStatement(singleDefault);
		} else if (t.isExpression(sd)) {
			return b.returnStatement(singleDefault);
		}
	}
	const rs = b.returnStatement(objEx);
	return rs;
}

function getParser(ts: boolean = false, jsx: boolean = false) {
	const plugins: ParserPlugin[] = [];
	if (jsx) plugins.push("jsx");
	if (ts) plugins.push("typescript");
	return {
		parse: (src: string) => {
			return doParse(src, {
				allowAwaitOutsideFunction: true,
				plugins,
				sourceType: "module",
				errorRecovery: true,
				tokens: true,
			});
		},
	};
}

async function transformImportsAndExportsOld(
	code: string,
	plugin: DatacoreJSTransformPlugin | null = null,
	typescript: boolean = false,
	useJsx: boolean = false,
	resolveRelativeTo: string | null = null
) {
	let parser = getParser(typescript, useJsx);
	const ast = parser.parse(code);
	babel.traverse(ast);
	/* const possiblePathEntries: { [key: string]: string[] } = Object.fromEntries(
		await Promise.all(
			otherImports.map(async (s) => {
				console.log("ssss", s);
				return [
					s,
					plugin ? (await plugin.settings.downloadedNpmLibs[s]) ?? [] : [],
				];
			})
		)
	);
	for (let s of otherImports) {
		try {
			if (plugin) await plugin.addPackage(s);
		} catch (e) {
			console.error(e);
			throw e;
		}
	}
	try {
		babel.traverse(ast, {});
	} catch (e) {
		console.error(e);
		throw e;
	}
	return generate(ast).code; */
}

function groupBy<K, T>(items: T[], keyFn: (it: T) => K): Map<K, T[]> {
	if (items.length == 0) return new Map();
	const inter = items.sort((a, b) =>
		keyFn(a) < keyFn(b) ? -1 : keyFn(a) > keyFn(b) ? 1 : 0
	);
	let result: { key: K; rows: T[] }[] = [];
	let cur = [inter[0]];
	let curKey = keyFn(inter[0]);
	for (let idx = 1; idx < inter.length; idx++) {
		let nk = keyFn(inter[idx]);
		if (curKey != nk) {
			result.push({ key: curKey, rows: cur });
			curKey = nk;
			cur = [inter[idx]];
		} else {
			cur.push(inter[idx]);
		}
	}
	return result.reduce((pv, cv) => {
		pv.set(cv.key, cv.rows);
		return pv;
	}, new Map<K, T[]>());
}

function convertRelative(
	src: string,
	outerBaseDir: string,
	importPaths: TransformOptions["importPaths"],
	filename?: string
) {
	let base = src;
	let aux: string | null = null;
	if (src.split("/").length > 2) {
		base = src.split("/").slice(0, 2).join("/");
		aux = src.split("/").slice(2).join("/");
	}
	let entry: string | undefined = importPaths[base]?.files?.find(
		(a) =>
			a.endsWith(importPaths[base].entryPoint) &&
			DatacoreJSTransformPlugin.exts.includes(pathutils.extname(a))
	);
	if (aux) {
		entry = importPaths[base]?.files?.find(
			(a) =>
				aux.split("/").every((b) => a.includes(b)) &&
				DatacoreJSTransformPlugin.exts.includes(pathutils.extname(a))
		);
	}
	if ((src.startsWith("./") || src.startsWith("..")) && filename) {
		entry = pathutils.join(outerBaseDir ?? pathutils.dirname(filename), src);
		if (!DatacoreJSTransformPlugin.exts.includes(pathutils.extname(entry))) {
			const tmp = entry;
			const splitDir = pathutils.dirname(entry).split(/\/|\\/);
			const chopped = splitDir.slice(splitDir.indexOf("libs") + 1);
			// scuffed sliding window algorithm i guess..?
			let libName: string | null = null;
			outer: for (let i = 0; i < chopped.length; i++) {
				for (let j = 1; j <= 2; j++) {
					const libStart = chopped.slice(0, j).join("/");
					if (libStart.slice(0, libStart.lastIndexOf("@")) in importPaths) {
						libName = libStart.slice(0, libStart.lastIndexOf("@"));
						break outer;
					}
				}
			}
			entry = importPaths[libName!]?.files?.find((a) =>
				DatacoreJSTransformPlugin.exts.some((b) => a == tmp! + b)
			);
		}
	}
	if (!entry)
		entry =
			importPaths[base] && importPaths[base].entryPoint
				? importPaths[base]?.baseDir + "/" + importPaths[base]?.entryPoint
				: undefined;
	if (!entry) {
		entry = importPaths[base]?.files?.find(
			(a) => a.endsWith("index.js") && !a.includes("cjs")
		);
	}
	return entry;
}

export function transformImportsAndExports({ types: t }: typeof Babel) {
	let dcImports: ImportSpecifier[] = [];
	let dcHooks: ImportSpecifier[] = [];
	let otherImports: string[] = [];
	let dcExports: ExportArray = [];
	let allDecls: ExportAllDeclaration[] = [];
	const visitor: Babel.Visitor<Babel.PluginPass & { opts: TransformOptions }> =
		{
			ImportDeclaration(path: NodePath<ImportDeclaration>, state) {
				let node = path.node;
				let src: string = node.source.value;
				if (["react", "preact", "preact/hooks"].includes(node.source.value)) {
					let hooks = node.specifiers.filter(
						(s: ImportSpecifier) =>
							t.isImportSpecifier(s) &&
							t.isIdentifier(s.imported) &&
							s.imported.name.startsWith("use")
					) as ImportSpecifier[];
					let other: ImportArray = node.specifiers.filter(
						(
							s:
								| ImportSpecifier
								| ImportDefaultSpecifier
								| ImportNamespaceSpecifier
						) =>
							(t.isImportSpecifier(s) &&
								t.isIdentifier(s.imported) &&
								!(s.imported.name as string).startsWith("use")) ||
							t.isImportDefaultSpecifier(s) ||
							t.isImportNamespaceSpecifier(s)
					) as ImportArray;
					dcHooks.push(...hooks);
					/* let hookSpecs = replaceWithIdent(
					hooks,
					dcMember(b.identifier("hooks"))
				); */
					let otherSpecs = replaceWithIdent(
						other,
						dcMember(b.identifier("preact"))
					);
					const finalReplacement = [];
					// if (hookSpecs.declarations.length) finalReplacement.push(hookSpecs);
					finalReplacement.push(otherSpecs);

					path.replaceWithMultiple(finalReplacement);
				} else if (node.source.value == "react-dom") {
					let specs = replaceWithIdent(
						node.specifiers as ImportArray,
						dcMember(b.identifier("preact"))
					);
					path.replaceWith(specs);
				} else if (node.source.value.startsWith("react/jsx-")) {
					path.replaceWith(
						replaceWithIdent(
							node.specifiers as ImportArray,
							dcMember(b.identifier("jsxRuntime"))
						)
					);
				} else if (src === "#datacore") {
					dcImports.push(...(node.specifiers as ImportSpecifier[]));
					path.remove();
				} else if (
					state.opts.vaultFiles.find((a) => a.startsWith(src)) ||
					src.includes("#") ||
					src.includes("^")
				) {
					const awaiter = b.awaitExpression(
						b.callExpression(b.memberExpression(dc, dcRequire), [
							b.stringLiteral(src),
						])
					);
					const specs = replaceWithIdent(
						node.specifiers as ImportArray,
						awaiter
					);
					path.replaceWith(specs);
					// await dc.require...
				} /* else if (resolveRelativeTo != null) {
					if (src.startsWith("./") || src.startsWith("..")) {
						let apath = pathutils.join(resolveRelativeTo, src);
						const awaiter = b.awaitExpression(
							b.callExpression(b.memberExpression(dc, dcRequire), [
								b.stringLiteral(apath),
							])
						);
						const specs = replaceWithIdent(
							node.specifiers as ImportArray,
							awaiter
						);
						path.replaceWith(specs);
					} else if (plugin != null && src.split("/").length == 2) {
						otherImports.push(src);
					}
				} */ /* if (plugin != null && src.split("/").length == 2) */ else {
					let entry = convertRelative(
						src,
						state.opts.outerBaseDir,
						state.opts.importPaths,
						state.filename
					);
					if (entry) {
						const awaiter = b.awaitExpression(
							b.callExpression(b.memberExpression(dc, dcRequire), [
								b.stringLiteral(entry!),
							])
						);
						const specs = replaceWithIdent(
							node.specifiers as ImportArray,
							awaiter
						);
						path.replaceWith(specs);
					} else {
						path.remove();
					}

					otherImports.push(src);
				}
				//console.log("p", node, dcImports);
			},
			ExpressionStatement(path, state) {
				const node = path.node;
				if (t.isCallExpression(node.expression)) {
					if (t.isMemberExpression(node.expression.callee)) {
						if (t.isIdentifier(node.expression.arguments[0])) {
							if (
								node.expression.arguments[0].name == "exports" &&
								node.expression.arguments.length == 3
							) {
								const ident = mustIdent(
									node.expression.arguments[1] as StringLiteral
								);
								let value: t.ExpressionStatement | null = null;
								if (ident.name != "__esModule") {
									const objEx = node.expression
										.arguments[2] as t.ObjectExpression;
									const val: ObjectProperty | undefined = objEx.properties.find(
										(a) =>
											t.isObjectProperty(a) &&
											t.isIdentifier(a.key) &&
											(a.key.name == "value" || a.key.name == "get")
									) as ObjectProperty;
									if (val) {
										const key = val.key as Identifier;
										if (key.name == "value") {
											value = t.expressionStatement(val.value as Expression);
										} else if (key.name == "get") {
											const body = val.value as t.FunctionExpression;
											value = t.expressionStatement(
												t.callExpression(
													t.functionExpression(
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
											t.exportNamedDeclaration(
												t.variableDeclaration("const", [
													t.variableDeclarator(ident, value?.expression),
												])
											)
										);
									}
									path.remove();
								} else {
									path.remove();
								}
							}
						}
					}
				}
			},
			CallExpression(path, state) {
				const node = path.node;

				if (
					dcImports.find(
						(a) =>
							t.isIdentifier(a.imported) &&
							a.imported.name == (node.callee as Identifier).name
					) != null ||
					dcHooks.find(
						(a) =>
							t.isIdentifier(a.imported) &&
							a.imported.name == (node.callee as Identifier).name
					) != null
				) {
					const nm = b.memberExpression(dc, node.callee as Identifier);
					path.replaceWith(b.callExpression(nm, node.arguments));
				} else if (
					t.isIdentifier(node.callee) &&
					node.callee.name == "require"
				) {
					let entry = convertRelative(
						(node.arguments[0] as StringLiteral).value,
						state.opts.outerBaseDir,
						state.opts.importPaths,
						state.filename
					);
					if (entry) {
						const awaiter = b.awaitExpression(
							b.callExpression(b.memberExpression(dc, dcRequire), [
								b.stringLiteral(entry!),
							])
						);
						path.replaceWith(awaiter);
					} else {
						path.remove();
					}
				}
			},
			AssignmentExpression(path, state) {
				const node = path.node;
				const isModuleExports = (
					node: t.LVal | t.OptionalMemberExpression
				): boolean => {
					if (t.isMemberExpression(node)) {
						if (t.isIdentifier(node.property) && t.isIdentifier(node.object)) {
							return (
								node.object.name == "module" && node.property.name == "exports"
							);
						} else if (t.isMemberExpression(node.object)) {
							return isModuleExports(node.object);
						}
					}
					return false;
				};
				const isExports = (
					node: t.LVal | t.OptionalMemberExpression
				): boolean => {
					if (t.isMemberExpression(node)) {
						if (t.isIdentifier(node.property) && t.isIdentifier(node.object)) {
							return node.object.name == "exports";
						}
					}
					return false;
				};
				if (isModuleExports(node.left)) {
					let me = node.left as t.MemberExpression;
					if (
						t.isMemberExpression(me.object) &&
						t.isIdentifier(me.object.property)
					) {
						const prop = t.isIdentifier(me.property)
							? me.property
							: t.identifier((me.property as StringLiteral).value);
						const vd = b.variableDeclaration("const", [
							b.variableDeclarator(prop, node.right),
						]);
						const final = b.exportNamedDeclaration(vd);
						dcExports.push(final);
						path.remove();
					} else {
						const final = b.exportDefaultDeclaration(node.right);
						dcExports.push(final);
						path.remove();
					}
				} else if (
					node.right.type == "UnaryExpression" &&
					node.right.operator == "void"
				) {
					path.parentPath.remove();
				} else if (isExports(node.left)) {
					let me = node.left as t.MemberExpression;
					const prop = t.isIdentifier(me.property)
						? me.property
						: t.identifier((me.property as StringLiteral).value);
					const vd = b.variableDeclaration("const", [
						b.variableDeclarator(prop, node.right),
					]);
					const final = b.exportNamedDeclaration(vd);
					dcExports.push(final);
					path.remove();
				}
			},
			JSXOpeningElement(path) {
				let toReplace = replaceJsxElement(path, dcImports);
				if (toReplace)
					path.replaceWith(
						b.jsxOpeningElement(
							toReplace,
							path.node.attributes,
							path.node.selfClosing
						)
					);
			},
			JSXClosingElement(path) {
				let toReplace = replaceJsxElement(path, dcImports);
				if (toReplace) path.replaceWith(b.jsxClosingElement(toReplace));
			},
			ExportNamedDeclaration(path, state) {
				const node: ExportNamedDeclaration = path.node;
				if (node.declaration) {
					dcExports.push(node);
					path.replaceWith(node.declaration);
				} else {
					if (node.source && node.specifiers.length) {
						let entry = convertRelative(
							node.source.value,
							state.opts.outerBaseDir,
							state.opts.importPaths,
							state.filename
						);
						if (entry) {
							const awaiter = b.awaitExpression(
								b.callExpression(b.memberExpression(dc, dcRequire), [
									b.stringLiteral(entry!),
								])
							);
							const specs = replaceWithIdent(
								node.specifiers as ExportSpecifier[],
								awaiter
							);
							dcExports.push(
								t.exportNamedDeclaration(
									null,
									(specs as t.VariableDeclaration).declarations.flatMap(
										(a: VariableDeclarator) => {
											const fin: ExportSpecifier[] = [];
											if (t.isIdentifier(a.id)) {
												fin.push(t.exportSpecifier(a.id, a.id))
											} else if (t.isObjectPattern(a.id)) {
												fin.push(
													...a.id.properties.map((b: ObjectProperty) =>
														t.exportSpecifier(
															b.value as Identifier,
															b.key as Identifier | StringLiteral
														)
													)
												);
											}
											return fin;
										}
									)
								)
							);
							path.replaceWithMultiple(specs);
						} else {
							dcExports.push(node);
							path.remove();
						}
					} else {
						dcExports.push(node);
						path.remove();
					}
				}
			},
			ExportAllDeclaration(path, state) {
				allDecls.push(path.node);
				path.remove();
			},
			ExportDefaultDeclaration(path) {
				const node: ExportDefaultDeclaration = path.node;
				dcExports.push(node);
				path.remove();
			},
		};
	return {
		manipulateOptions(opts, parserOpts) {
			parserOpts.plugins.push("jsx", "typescript");
			parserOpts.allowReturnOutsideFunction = true;
			parserOpts.allowAwaitOutsideFunction = true;
			parserOpts.errorRecovery = true;
		},
		visitor,
		post(file) {
			const originalExports = convertExports(
				dcExports.filter((a) => !(a as any).source),
				this.opts.outerBaseDir,
				this.opts.importPaths,
				this.filename
			);

			const that = this;
			const aggregatedAll = b.objectExpression(
				allDecls.map((a) => {
					const convertedSource = convertRelative(
						a.source.value,
						that.opts.outerBaseDir,
						that.opts.importPaths,
						that.filename
					);
					const spreads = b.spreadElement(
						convertImportToDcRequire(b.stringLiteral(convertedSource!))
					);
					return spreads;
				})
			);
			if (t.isObjectExpression(originalExports.argument)) {
				originalExports.argument.properties.push(...aggregatedAll.properties);
			}
			file.ast.program.body.push(originalExports);
			Babel.traverse(file.ast, {
				CallExpression(path, state) {
					const orig = visitor.CallExpression! as Function;
					orig(path, that);
				},
				AssignmentExpression(path, state) {
					const orig = visitor.AssignmentExpression as Function;
					orig(path, that);
				},
			});

			file.code = generate(file.ast).code;
		},
	} as PluginObj<
		Babel.PluginPass & {
			opts: TransformOptions;
		}
	>;
}
export function transformExtraImports(): PluginObj<
	Babel.PluginPass & {
		opts: {
			possiblePathEntries: {
				[k: string]: string[];
			};
		};
	}
> {
	return {
		inherits: () => [syntaxTs, syntaxJsx],
		visitor: {
			ImportDeclaration(path, state) {
				const vals = Object.values(state.opts.possiblePathEntries).flatMap(
					(a) => a
				);
				const node = path.node;
				const src = node.source.value;
				const str = vals.find((a) => a.replace(/\.\w*?js$/m, "").endsWith(src));
				if (str) {
					const awaiter = b.awaitExpression(
						b.callExpression(b.memberExpression(dc, dcRequire), [
							b.stringLiteral(str),
						])
					);
					path.replaceWith(
						replaceWithIdent(node.specifiers as ImportArray, awaiter)
					);
				} else {
					path.remove();
				}
			},
		},
	};
}
