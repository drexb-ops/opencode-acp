import { builtinModules, createRequire } from "node:module"
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const expectedPackageName = "opencode-acp"
const semverPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const builtinNames = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => name.replace(/^node:/, "")),
])

const entrypointFiles = [
    "dist/index.js",
    "dist/index.js.map",
    "dist/index.d.ts",
    "dist/index.d.ts.map",
    "dist/tui.js",
    "dist/tui.js.map",
    "dist/tui.d.ts",
    "dist/tui.d.ts.map",
    "dist/rpc.js",
    "dist/rpc.js.map",
    "dist/rpc.d.ts",
    "dist/rpc.d.ts.map",
]

const requiredRepoFiles = [
    "package.json",
    "package-lock.json",
    ...entrypointFiles,
    "README.md",
    "LICENSE",
]

const requiredTarballFiles = ["package.json", ...entrypointFiles, "README.md", "LICENSE"]

const forbiddenTarballPatterns = [
    /^node_modules\//,
    /^lib\//,
    /^src\//,
    /^source\//,
    /^(?:index|rpc|tui)\.ts$/,
    /^tests\//,
    /^scripts\//,
    /^docs\//,
    /^assets\//,
    /^notes\//,
    /^\.github\//,
    /^package-lock\.json$/,
    /^tsconfig(?:\.[^/]+)?\.json$/,
    /^tsup\.config\.[^/]+$/,
]

// These checks intentionally inspect only archive member names. They never read
// or print the contents of a candidate credential/private-key file.
const credentialFilenamePatterns = [
    /(^|\/)\.env(?:\.|$)/i,
    /(^|\/)(?:credentials?|secrets?)(?:[-_.].*)?$/i,
    /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*private[-_.]?key.*)$/i,
    /\.(?:pem|key|p12|pfx|jks)$/i,
    /(^|\/).*?(?:api[-_.]?key|access[-_.]?token|auth[-_.]?token|service[-_.]?account).*$/i,
]

const packageInfoCache = new Map()

function fail(message) {
    throw new Error(message)
}

function readJson(relativePath) {
    try {
        return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"))
    } catch {
        fail(`unable to read JSON metadata: ${relativePath}`)
    }
}

function assertRepoFilesExist() {
    for (const relativePath of requiredRepoFiles) {
        if (!existsSync(path.join(root, relativePath))) {
            fail(`missing required build or repository file: ${relativePath}`)
        }
    }
}

function assertDependencyMapsMatch(pkg, lockRoot) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const expected = pkg[field] ?? {}
        const actual = lockRoot[field] ?? {}
        const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()

        for (const name of names) {
            if (expected[name] !== actual[name]) {
                fail(
                    `package-lock root ${field} is inconsistent for ${name}: ` +
                        `${actual[name] ?? "<missing>"} does not match ${expected[name] ?? "<missing>"}`,
                )
            }
        }
    }
}

function assertPackageManifestAndLock() {
    const pkg = readJson("package.json")
    const lock = readJson("package-lock.json")
    const lockRoot = lock.packages?.[""]

    if (
        pkg.name !== expectedPackageName ||
        typeof pkg.version !== "string" ||
        !semverPattern.test(pkg.version)
    ) {
        fail(
            `package.json must contain ${expectedPackageName} and a valid semver version, ` +
                `found ${pkg.name ?? "<missing>"}@${pkg.version ?? "<missing>"}`,
        )
    }

    if (!lockRoot) {
        fail("package-lock.json is missing its root package metadata")
    }
    if (lock.name !== pkg.name || lock.version !== pkg.version) {
        fail("package-lock.json top-level name/version do not match package.json")
    }
    if (lockRoot.name !== pkg.name || lockRoot.version !== pkg.version) {
        fail("package-lock.json root package name/version do not match package.json")
    }
    assertDependencyMapsMatch(pkg, lockRoot)

    return pkg
}

function assertExportShape(actual, expected, label) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
        fail(`${label} must be an export condition object`)
    }

    const actualKeys = Object.keys(actual).sort()
    const expectedKeys = Object.keys(expected).sort()
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        fail(`${label} must expose exactly types and import conditions`)
    }

    for (const key of expectedKeys) {
        if (actual[key] !== expected[key]) {
            fail(`${label}.${key} must be ${expected[key]}, found ${actual[key] ?? "<missing>"}`)
        }
    }
}

function assertPackageJsonShape(pkg) {
    if (pkg.main !== "./dist/index.js") {
        fail(`package.json main must remain ./dist/index.js, found ${pkg.main ?? "<missing>"}`)
    }
    if (pkg.types !== "./dist/index.d.ts") {
        fail(`package.json types must remain ./dist/index.d.ts, found ${pkg.types ?? "<missing>"}`)
    }

    const expectedExports = {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./server": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./tui": { types: "./dist/tui.d.ts", import: "./dist/tui.js" },
        "./rpc": { types: "./dist/rpc.d.ts", import: "./dist/rpc.js" },
    }
    const exports = pkg.exports
    if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
        fail("package.json exports must be an object")
    }

    const actualExportKeys = Object.keys(exports).sort()
    const expectedExportKeys = Object.keys(expectedExports).sort()
    if (JSON.stringify(actualExportKeys) !== JSON.stringify(expectedExportKeys)) {
        fail(`package.json exports must contain exactly ${Object.keys(expectedExports).join(", ")}`)
    }
    for (const [subpath, expected] of Object.entries(expectedExports)) {
        assertExportShape(exports[subpath], expected, `package.json exports[${subpath}]`)
    }

    const files = Array.isArray(pkg.files) ? pkg.files : []
    for (const entry of ["dist/", "README.md", "LICENSE"]) {
        if (!files.includes(entry)) {
            fail(`package.json files must include ${entry}`)
        }
    }
}

function getImportStatements(source) {
    const entries = []

    const add = (clause, specifier, kind = null) => {
        entries.push({ clause: clause.trim(), specifier, kind: kind ?? getImportKind(clause) })
    }

    // Keep this deliberately small and dependency-free: the source graph only
    // needs import/export specifiers, while tsup's output is checked separately.
    const staticImports = /\bimport\s+(?!\()([\s\S]*?)\s+from\s+["']([^"']+)["']/g
    for (const match of source.matchAll(staticImports)) add(match[1], match[2])

    const sideEffectImports = /\bimport\s+["']([^"']+)["']/g
    for (const match of source.matchAll(sideEffectImports)) add("", match[1], "side-effect")

    const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
    for (const match of source.matchAll(dynamicImports)) add("", match[1], "dynamic")

    const reExports = /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g
    for (const match of source.matchAll(reExports)) add("", match[1], "re-export")

    return entries
}

function getImportKind(clause) {
    if (clause.startsWith("type ")) return "type"
    if (clause.startsWith("* as ")) return "namespace"
    if (clause.startsWith("{")) return "named"
    if (clause.includes(",")) {
        const [, trailing = ""] = clause.split(",", 2)
        return trailing.trim().startsWith("* as ") ? "default+namespace" : "default+named"
    }
    return "default"
}

function getPackageName(specifier) {
    if (specifier.startsWith("@")) {
        const parts = specifier.split("/")
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
    }
    return specifier.split("/")[0]
}

function resolveLocalImport(importerPath, specifier) {
    const basePath = path.resolve(path.dirname(importerPath), specifier)
    const candidates = [
        basePath,
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(
            (extension) => `${basePath}${extension}`,
        ),
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(
            (extension) => path.join(basePath, `index${extension}`),
        ),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }

    fail(`unable to resolve local import ${specifier} from ${path.relative(root, importerPath)}`)
}

function findPackageInfo(packageName, importerPath) {
    const cacheKey = `${packageName}::${path.dirname(importerPath)}`
    if (packageInfoCache.has(cacheKey)) {
        return packageInfoCache.get(cacheKey)
    }

    let entry
    try {
        entry = require.resolve(packageName, { paths: [path.dirname(importerPath)] })
    } catch {
        packageInfoCache.set(cacheKey, null)
        return null
    }

    let current = path.dirname(entry)
    while (true) {
        const manifest = path.join(current, "package.json")
        if (existsSync(manifest)) {
            const info = JSON.parse(readFileSync(manifest, "utf8"))
            packageInfoCache.set(cacheKey, info)
            return info
        }
        const parent = path.dirname(current)
        if (parent === current) {
            packageInfoCache.set(cacheKey, null)
            return null
        }
        current = parent
    }
}

function packageLooksCommonJs(pkg) {
    if (!pkg) return false
    if (pkg.type === "commonjs") return true

    // `require.resolve()` intentionally resolves through the CommonJS
    // condition, so a dual package such as zod can have a .cjs `main` while
    // its ESM import condition is safe for this package.
    const rootExport = pkg.exports?.["."]
    const importTarget =
        typeof rootExport === "string"
            ? rootExport
            : rootExport && typeof rootExport === "object"
              ? (rootExport.import ?? rootExport.default)
              : null
    if (importTarget) {
        return /(?:^|\/)(cjs|umd)(?:\/|$)/.test(importTarget) || importTarget.endsWith(".cjs")
    }

    const main = typeof pkg.main === "string" ? pkg.main : ""
    return /(?:^|\/)(cjs|umd)(?:\/|$)/.test(main) || main.endsWith(".cjs")
}

function validateSourceRuntimeImportGraph() {
    const pending = ["index.ts", "tui.ts", "rpc.ts"].map((entry) => path.join(root, entry))
    const seen = new Set()

    while (pending.length > 0) {
        const filePath = pending.pop()
        if (!filePath || seen.has(filePath)) continue
        seen.add(filePath)

        const source = readFileSync(filePath, "utf8")
        for (const entry of getImportStatements(source)) {
            if (entry.kind === "type") continue

            if (entry.specifier.startsWith(".")) {
                pending.push(resolveLocalImport(filePath, entry.specifier))
                continue
            }

            if (entry.specifier === "jsonc-parser/lib/esm/main.js") continue

            const packageName = getPackageName(entry.specifier)
            if (builtinNames.has(packageName)) continue

            if (entry.kind === "namespace") continue

            const pkg = findPackageInfo(packageName, filePath)
            if (packageLooksCommonJs(pkg)) {
                fail(
                    `${path.relative(root, filePath)} uses ${entry.kind} import from ` +
                        `CommonJS-style package ${packageName}`,
                )
            }
        }
    }
}

function normalizeArchivePath(relativePath) {
    return relativePath.split(path.sep).join("/")
}

function resolveBuiltImport(importerPath, specifier) {
    const basePath = path.resolve(path.dirname(importerPath), specifier)
    const candidates = [
        basePath,
        `${basePath}.js`,
        `${basePath}.mjs`,
        `${basePath}.cjs`,
        path.join(basePath, "index.js"),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }

    fail(
        `unable to resolve built relative import ${specifier} from ${path.relative(root, importerPath)}`,
    )
}

function validateBuiltRuntimeImportGraph(packedPaths) {
    const pending = ["dist/index.js", "dist/tui.js", "dist/rpc.js"].map((entry) =>
        path.join(root, entry),
    )
    const seen = new Set()
    const distRoot = path.join(root, "dist")

    while (pending.length > 0) {
        const filePath = pending.pop()
        if (!filePath || seen.has(filePath)) continue
        seen.add(filePath)

        const source = readFileSync(filePath, "utf8")
        for (const { specifier } of getImportStatements(source)) {
            if (!specifier.startsWith(".")) continue

            const resolved = resolveBuiltImport(filePath, specifier)
            const relativeToDist = path.relative(distRoot, resolved)
            if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
                fail(
                    `built relative import escapes dist/: ${path.relative(root, filePath)} -> ${specifier}`,
                )
            }

            const archivePath = normalizeArchivePath(path.relative(root, resolved))
            if (!packedPaths.has(archivePath)) {
                fail(`packed tarball is missing runtime import ${archivePath}`)
            }
            pending.push(resolved)
        }
    }
}

function copyPackFiles(pkg, stagingRoot) {
    const files = Array.isArray(pkg.files) ? pkg.files : []
    for (const entry of files) {
        const relativePath = entry.replace(/\/$/, "")
        if (!relativePath) continue

        const source = path.resolve(root, relativePath)
        const destination = path.resolve(stagingRoot, relativePath)
        const rootPrefix = `${root}${path.sep}`
        const stagingPrefix = `${stagingRoot}${path.sep}`
        if (!source.startsWith(rootPrefix) || !destination.startsWith(stagingPrefix)) {
            fail(`package.json files entry escapes the repository: ${entry}`)
        }
        if (!existsSync(source)) {
            fail(`package.json files entry is missing: ${entry}`)
        }

        mkdirSync(path.dirname(destination), { recursive: true })
        cpSync(source, destination, { recursive: true })
    }
}

function stagePackageForPack(pkg) {
    const stagingParent = "/tmp/opencode"
    mkdirSync(stagingParent, { recursive: true })
    const stagingRoot = mkdtempSync(path.join(stagingParent, "opencode-acp-package-"))

    try {
        copyPackFiles(pkg, stagingRoot)

        // npm's directory packer runs `prepare` even when --ignore-scripts is
        // supplied. Remove only that lifecycle hook from the staging manifest
        // so verification never launches a nested build; the packed file list
        // still comes from the checked-in `files` field and built dist/.
        const stagedPackage = JSON.parse(JSON.stringify(pkg))
        if (stagedPackage.scripts) {
            delete stagedPackage.scripts.prepare
        }
        writeFileSync(
            path.join(stagingRoot, "package.json"),
            `${JSON.stringify(stagedPackage, null, 4)}\n`,
        )

        return { stagingRoot, cleanup: () => rmSync(stagingRoot, { recursive: true, force: true }) }
    } catch (error) {
        rmSync(stagingRoot, { recursive: true, force: true })
        throw error
    }
}

function inspectPackedFiles(pkg) {
    const staged = stagePackageForPack(pkg)
    try {
        let output
        try {
            output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
                cwd: staged.stagingRoot,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch {
            fail("npm pack --dry-run --json --ignore-scripts failed")
        }

        let results
        try {
            results = JSON.parse(output.trim())
        } catch {
            fail("npm pack --dry-run --json --ignore-scripts did not return JSON metadata")
        }

        const [result] = results
        if (!result || !Array.isArray(result.files)) {
            fail("npm pack --dry-run --json --ignore-scripts did not return file metadata")
        }
        if (result.name !== pkg.name || result.version !== pkg.version) {
            fail("npm pack metadata name/version do not match package.json")
        }

        const packedPaths = new Set(result.files.map((file) => file.path))
        for (const required of requiredTarballFiles) {
            if (!packedPaths.has(required)) {
                fail(`packed tarball is missing ${required}`)
            }
        }

        const forbidden = [...packedPaths].find((file) =>
            forbiddenTarballPatterns.some((pattern) => pattern.test(file)),
        )
        if (forbidden) {
            fail(`packed tarball contains forbidden path ${forbidden}`)
        }

        const credentialLike = [...packedPaths].find((file) =>
            credentialFilenamePatterns.some((pattern) => pattern.test(file)),
        )
        if (credentialLike) {
            fail(`packed tarball contains credential-like filename ${credentialLike}`)
        }

        return { result, packedPaths }
    } finally {
        staged.cleanup()
    }
}

async function importWithTimeout(specifier, label) {
    let timer
    try {
        return await Promise.race([
            import(specifier),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("module import timed out")), 5000)
            }),
        ])
    } catch {
        fail(`unable to dynamically import built ${label} entrypoint`)
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function assertServerDefinition(module, label) {
    const definition = module?.default
    if (!definition || typeof definition !== "object") {
        fail(`${label} default export must be an object`)
    }
    if (definition.id !== expectedPackageName) {
        fail(`${label} default export id must be ${expectedPackageName}`)
    }
    if (typeof definition.setup !== "function" || typeof definition.server !== "function") {
        fail(`${label} default export must provide setup() and server()`)
    }
    return definition
}

function assertTuiDefinition(module) {
    const expectedId = "opencode-acp-tui"
    if (module?.ACP_TUI_PLUGIN_ID !== expectedId) {
        fail(`TUI entrypoint must export stable ID ${expectedId}`)
    }
    const definition = module?.default
    if (!definition || definition.id !== expectedId || typeof definition.setup !== "function") {
        fail(`TUI default export must provide id ${expectedId} and setup()`)
    }
}

function assertRpcDefinition(module) {
    const rpc = module?.AcpRpc
    const notification = rpc?.events?.notification
    const required = notification?.schema?.required
    if (
        rpc?.id !== expectedPackageName ||
        !notification ||
        typeof notification.schema !== "object"
    ) {
        fail(`RPC entrypoint must expose ${expectedPackageName} with a notification event schema`)
    }
    if (
        !Array.isArray(required) ||
        !["title", "message", "variant"].every((field) => required.includes(field))
    ) {
        fail("RPC notification schema must require title, message, and variant")
    }
}

async function validateBuiltModules(pkg) {
    const rootModule = await importWithTimeout(pkg.name, "root")
    const serverModule = await importWithTimeout(`${pkg.name}/server`, "server")
    const tuiModule = await importWithTimeout(`${pkg.name}/tui`, "TUI")
    const rpcModule = await importWithTimeout(`${pkg.name}/rpc`, "RPC")

    const rootDefinition = assertServerDefinition(rootModule, "root")
    const serverDefinition = assertServerDefinition(serverModule, "server")
    if (rootDefinition !== serverDefinition) {
        fail("root and ./server must resolve the same dual server definition")
    }
    assertTuiDefinition(tuiModule)
    assertRpcDefinition(rpcModule)
}

async function main() {
    assertRepoFilesExist()
    const pkg = assertPackageManifestAndLock()
    assertPackageJsonShape(pkg)
    validateSourceRuntimeImportGraph()

    const { result, packedPaths } = inspectPackedFiles(pkg)
    validateBuiltRuntimeImportGraph(packedPaths)
    await validateBuiltModules(pkg)

    console.log(`package verification passed for ${result.name}@${result.version}`)
    console.log(`tarball entries: ${result.entryCount ?? result.files.length}`)
    console.log(`entrypoint files: ${entrypointFiles.join(", ")}`)
}

try {
    await main()
} catch (error) {
    console.error(
        `package verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
    )
    process.exitCode = 1
}
