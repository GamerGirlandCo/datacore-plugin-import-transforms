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
import pathutils from "@chainner/node-path";
import { parse as doParse, parse, ParserPlugin } from "@babel/parser";
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

export const exts = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".d.ts", "package.json"];
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
	}
}
export interface TransformRequest {
	possiblePaths: string[];
}

const dc = b.identifier("dc");
const dcJsx = b.jsxIdentifier("dc");
const dcRequire = b.identifier("require");

export const stripName = (k: string) => {
	const lio = k.lastIndexOf("@");
	if (lio > 0) {
		return k.substring(0, lio);
	}
	return k;
};

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
	opts: TransformOptions,
	filename?: string,
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
									opts,
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

const sep_regex = /\/|\\/;
function convertRelative(
	src: string,
	opts: TransformOptions,
	filename?: string
) {
	const {importPaths, version, dependencies: deps} = opts
	if (
		filename &&
		(pathutils.isAbsolute(filename) || pathutils.win32.isAbsolute(filename))
	)
		filename = filename
			.split(sep_regex)
			.slice(filename.split(sep_regex).indexOf(".obsidian"))
			.join("/");
	let base = src;
	let key = `${base}@${version}`
	let aux: string | null = null;
	if (src.split("/").length > 2 && !src.startsWith("./") && !src.startsWith("..")) {
		base =  src.split("/").slice(0, 2).join("/");
		key = `${base}@${version}`
		if(!importPaths[key])
			key = deps.find(a => a.startsWith(base))!
		aux = src.split("/").slice(2).join("/");
	}
	if(!importPaths[key] && !src.startsWith("./") && !src.startsWith("..")) {
		let nk = deps.find(a => {
			return a.startsWith(base)
		})
		if(nk)
			key = nk
		else
			key = `${base}@${opts.latestVersions[base]}`
	}

	let entry: string | undefined = importPaths[key]?.files?.find(
		(a) =>
			a.endsWith(importPaths[key].entryPoint) &&
			!a.includes("cjs") &&
			exts.includes(pathutils.extname(a))
	);
	if (aux && !src.startsWith("..") && !src.startsWith("./")) {
		entry = importPaths[key]?.files?.find((a) => {
			return aux
				.split("/")
				.every((b, i, arr) =>
					exts.some((c) =>
						i == arr.length - 1 ? a.endsWith(b + c) : (a.includes(`${b}/`))
					)
				) &&
				!a.includes("cjs") &&
				exts.includes(pathutils.extname(a));
		});
	}
	if ((src.startsWith("./") || src.startsWith("..")) && filename) {
		entry = pathutils.join(pathutils.dirname(filename), src).replace(/\\/g, "/");

		if (!exts.includes(pathutils.extname(entry))) {
			const tmp = entry.replace(/\\/g, "/");
			const splitDir = pathutils.dirname(entry).split(/\/|\\/);
			const chopped = splitDir.slice(splitDir.indexOf("libs") + 1);
			// scuffed sliding window algorithm i guess..?
			let libName: string | null = null;
			outer: for (let i = 0; i < chopped.length; i++) {
				for (let j = 1; j <= 2; j++) {
					const libStart = chopped.slice(0, j).join("/");
					if (libStart/* .slice(0, libStart.lastIndexOf("@")) */ in importPaths) {
						key = libName = libStart/* .slice(0, libStart.lastIndexOf("@")) */;
						break outer;
					}
				}
			}
			entry = importPaths[libName!]?.files?.find(
				(a) => exts.some((b) => a == (tmp! + b) || a.startsWith(tmp + b)) || a == tmp
			);
			if (!entry) {
				console.warn(entry);
			}
		}
	}
	if (!entry)
		entry =
			importPaths[key] && importPaths[key].entryPoint
				? importPaths[key]?.baseDir + "/" + importPaths[key]?.entryPoint
				: undefined;
	if (!entry) {
		if (aux) {
			const split = aux.split("/");
			entry = importPaths[key]?.files?.find(
				(a) =>
					exts.some((b) => a.endsWith(split[split.length - 1] + b)) ||
					a.endsWith(split[split.length - 1])
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
	hooks: ImportSpecifier[];
	other: ImportArray;
};
function convertImportOrRequire(
	source: string,
	specifiers: ImportArray = []
): ImportConvertResult {
	const ret: ImportConvertResult = {
		hooks: [],
		other: [],
	};
	if (["react", "preact", "preact/hooks"].includes(source)) {
		let hooks = specifiers.filter(
			(s: ImportSpecifier) =>
				t.isImportSpecifier(s) &&
				t.isIdentifier(s.imported) &&
				s.imported.name.startsWith("use")
		) as ImportSpecifier[];
		let other: ImportArray = specifiers.filter(
			(
				s: ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier
			) =>
				(t.isImportSpecifier(s) &&
					t.isIdentifier(s.imported) &&
					!(s.imported.name as string).startsWith("use")) ||
				t.isImportDefaultSpecifier(s) ||
				t.isImportNamespaceSpecifier(s)
		) as ImportArray;
		ret.hooks.push(...hooks);
		/* let hookSpecs = replaceWithIdent(
					hooks,
					dcMember(b.identifier("hooks"))
				); */
		ret.other.push(...other);
	}
	return ret;
}

export function transformImportsAndExports({ types: t }: typeof Babel) {
	let dcImports: ImportSpecifier[] = [];
	let dcHooks: ImportSpecifier[] = [];
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
				} else {
					let entry = convertRelative(
						src,
						state.opts,
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
				} /* if (plugin != null && src.split("/").length == 2) */
				/* else if (resolveRelativeTo != null) {
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
				} */
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
					node.callee.name == "require" &&
					t.isStringLiteral(node.arguments[0])
				) {
					let entry = convertRelative(
						(node.arguments[0] as StringLiteral).value,
						state.opts,
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
						if (
							t.isExpressionStatement(path.parent) ||
							t.isAssignmentExpression(path.parent) ||
							t.isConditionalExpression(path.parent)
						) {
							path.parentPath.remove();
						} else {
							path.remove();
						}
					}
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

					/* {
						let par = path.parentPath;
						path.remove();
						while (
							(t.isExpressionStatement(par.node) ||
								t.isAssignmentExpression(par.node) ||
								t.isConditionalExpression(par.node)) 
						) {
							if (par.parentPath) par = par.parentPath;
							else break;
						}
						if(par && !t.isProgram(par.node))
							try {
							par.remove();
						} catch(e) {
							console.debug(e)
						}
					} */
					if (
						t.isExpressionStatement(path.parent) ||
						t.isAssignmentExpression(path.parent) ||
						t.isConditionalExpression(path.parent) ||
						t.isObjectProperty(path.parent)
					) {
						path.replaceWith(t.expressionStatement(t.nullLiteral()));
					} else {
						path.remove();
					}
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
							state.opts,
							state.filename,
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
												fin.push(t.exportSpecifier(a.id, a.id));
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
				this.opts,
				this.filename,
			);

			const that = this;
			that.opts.isSecondPass = true;
			const aggregatedAll = b.objectExpression(
				allDecls.map((a) => {
					const convertedSource = convertRelative(
						a.source.value,
						that.opts,
						that.filename
					);
					if (convertedSource) {
						const spreads = b.spreadElement(
							convertImportToDcRequire(b.stringLiteral(convertedSource!))
						);
						return spreads;
					} else {
						return b.spreadElement(b.objectExpression([]));
					}
				})
			);
			if (t.isObjectExpression(originalExports.argument)) {
				originalExports.argument.properties.push(...aggregatedAll.properties);
			}
			// file.ast.program.body.unshift(b.variableDeclaration("let", [b.variableDeclarator(b.identifier("exports"), b.objectExpression([]))]))
			file.ast.program.body.push(originalExports);

			file.code = generate(file.ast).code;
		},
	} as PluginObj<
		Babel.PluginPass & {
			opts: TransformOptions;
		}
	>;
}
