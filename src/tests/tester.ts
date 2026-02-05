/* import transformImportsAndExports from "../util";
import { basename, join } from "path";
import {readFileSync, readdirSync, writeFileSync} from "fs";
export async function main() {
	const files = readdirSync("./example/dist", {
		withFileTypes: true
	}).filter(a => basename(a.name).startsWith("index.js"))[0];
	const testCode = readFileSync("src/tests/testee.tsx.file").toString();
	const code = readFileSync(join(files.parentPath, files.name)).toString();
	const testParseResult = await transformImportsAndExports(testCode, null, true, true)
	const parseResult = await transformImportsAndExports(code, null, false, true);
	writeFileSync("../test-vault/root/test-out.jsx", parseResult);	
	writeFileSync("test-out.jsx", parseResult);
	console.log(parseResult);
}

main().then(() => process.exit())
 */
