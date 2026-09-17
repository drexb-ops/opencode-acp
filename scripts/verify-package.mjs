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
import {
    assertMinimalProbeEnv,
    buildMinimalProbeEnv,
    captureOwnedDirectory,
    removeOwnedDirectory,
} from "./e2e/verification-guards.mjs"

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
const approvedStagingParent = "/tmp/opencode"
const stagingPrefix = "opencode-acp-package-"
const installPrefix = "opencode-acp-package-install-"

function fail(message) {
    throw new Error(message)
}

function ensureApprovedStagingParent() {
    mkdirSync(approvedStagingParent, { recursive: true })
    try {
        captureOwnedDirectory(approvedStagingParent, { label: "approved staging parent" })
    } catch (error) {
        fail(error instanceof Error ? error.message : "approved staging parent is unsafe")
    }
}

function removeExactStagingRoot(identity, prefix) {
    if (!identity) return
    try {
        removeOwnedDirectory(identity, { parent: approvedStagingParent, prefix })
    } catch (error) {
        fail(
            error instanceof Error
                ? `refusing unsafe owned-directory cleanup: ${error.message}`
                : "refusing unsafe owned-directory cleanup",
        )
    }
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
        try {
            const sourceStat = statSync(source)
            if (!sourceStat) fail(`package.json files entry is not stat-able: ${entry}`)
        } catch {
            fail(`package.json files entry is not a regular staged source: ${entry}`)
        }

        mkdirSync(path.dirname(destination), { recursive: true })
        cpSync(source, destination, { recursive: true })
    }
}

function stagePackageForPack(pkg) {
    ensureApprovedStagingParent()
    const stagingRoot = mkdtempSync(path.join(approvedStagingParent, stagingPrefix))
    const stagingIdentity = captureOwnedDirectory(stagingRoot, {
        label: "package staging root",
        parent: approvedStagingParent,
        prefix: stagingPrefix,
    })

    try {
        copyPackFiles(pkg, stagingIdentity.realPath)

        // npm's directory packer runs `prepare` even when --ignore-scripts is
        // supplied. Remove only that lifecycle hook from the staging manifest
        // so verification never launches a nested build; the packed file list
        // still comes from the checked-in `files` field and built dist/.
        const stagedPackage = JSON.parse(JSON.stringify(pkg))
        if (stagedPackage.scripts) {
            delete stagedPackage.scripts.prepare
        }
        writeFileSync(
            path.join(stagingIdentity.realPath, "package.json"),
            `${JSON.stringify(stagedPackage, null, 4)}\n`,
        )

        return {
            stagingRoot: stagingIdentity.realPath,
            stagingIdentity,
            cleanup: () => removeExactStagingRoot(stagingIdentity, stagingPrefix),
        }
    } catch (error) {
        removeExactStagingRoot(stagingIdentity, stagingPrefix)
        throw error
    }
}

function createPackedArtifact(pkg) {
    const staged = stagePackageForPack(pkg)
    try {
        const packHome = path.join(staged.stagingRoot, "home")
        const packNpmrc = path.join(staged.stagingRoot, "npmrc")
        const packGlobalNpmrc = path.join(staged.stagingRoot, "global-npmrc")
        const packTmp = path.join(staged.stagingRoot, "tmp")
        const packCache = path.join(staged.stagingRoot, "npm-cache")
        mkdirSync(packHome, { recursive: true })
        mkdirSync(packTmp, { recursive: true })
        mkdirSync(packCache, { recursive: true })
        writeFileSync(
            packNpmrc,
            "registry=https://registry.npmjs.org/\nfund=false\naudit=false\nupdate-notifier=false\n",
        )
        writeFileSync(packGlobalNpmrc, "")
        const npmEnv = buildMinimalProbeEnv({
            home: packHome,
            tmpdir: packTmp,
            userconfig: packNpmrc,
            globalconfig: packGlobalNpmrc,
            cache: packCache,
            npm: true,
        })
        assertMinimalProbeEnv(npmEnv, true)
        let output
        try {
            output = execFileSync(
                "npm",
                ["pack", "--json", "--ignore-scripts", "--pack-destination", staged.stagingRoot],
                {
                    cwd: staged.stagingRoot,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                    env: npmEnv,
                },
            )
        } catch {
            fail("npm pack --json --ignore-scripts failed while creating the verification tarball")
        }

        let results
        try {
            results = JSON.parse(output.trim())
        } catch {
            fail("npm pack --json --ignore-scripts did not return JSON metadata")
        }

        const [result] = results
        if (!result || !Array.isArray(result.files)) {
            fail("npm pack --json --ignore-scripts did not return file metadata")
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

        const filename = typeof result.filename === "string" ? result.filename : ""
        const tarballPath = filename
            ? path.resolve(staged.stagingRoot, filename)
            : path.join(staged.stagingRoot, `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`)
        if (
            !tarballPath.startsWith(`${staged.stagingRoot}${path.sep}`) ||
            !existsSync(tarballPath)
        ) {
            fail(
                "npm pack did not create the expected real tarball inside the approved staging root",
            )
        }

        let tarMembers
        try {
            tarMembers = execFileSync("tar", ["-tzf", tarballPath], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            })
                .trim()
                .split(/\r?\n/)
                .filter(Boolean)
                .map((member) => member.replace(/^package\//, ""))
        } catch {
            fail("created verification tarball could not be inspected")
        }
        const tarMemberSet = new Set(tarMembers)
        for (const required of requiredTarballFiles) {
            if (!tarMemberSet.has(required)) {
                fail(`created tarball is missing member ${required}`)
            }
        }

        return { result, packedPaths, tarballPath, cleanup: staged.cleanup }
    } catch (error) {
        staged.cleanup()
        throw error
    }
}

function validateInstalledModules(pkg, installRoot, packageDir) {
    captureOwnedDirectory(packageDir, {
        label: "installed package directory",
        parent: installRoot,
        prefix: pkg.name,
    })
    const probePath = path.join(installRoot, `.opencode-acp-entrypoint-probe-${process.pid}.mjs`)
    const probeSource = `
import { fileURLToPath } from "node:url"
import path from "node:path"

const specs = [
    ["root", ${JSON.stringify(pkg.name)}],
    ["server", ${JSON.stringify(`${pkg.name}/server`)}],
    ["TUI", ${JSON.stringify(`${pkg.name}/tui`)}],
    ["RPC", ${JSON.stringify(`${pkg.name}/rpc`)}],
]
const modules = new Map()
for (const [label, specifier] of specs) {
    try {
        modules.set(label, await import(specifier))
    } catch (error) {
        throw new Error(
            "installed " + label + " entrypoint import failed: " +
                (error instanceof Error ? error.message : String(error)),
        )
    }
}

const rootModule = modules.get("root")
const serverModule = modules.get("server")
const tuiModule = modules.get("TUI")
const rpcModule = modules.get("RPC")
const rootDefinition = rootModule?.default
if (!rootDefinition || typeof rootDefinition !== "object") {
    throw new Error("installed root entrypoint default export must be an object")
}
if (rootDefinition.id !== ${JSON.stringify(expectedPackageName)}) {
    throw new Error("installed root entrypoint default export has the wrong id")
}
if (typeof rootDefinition.setup !== "function" || typeof rootDefinition.server !== "function") {
    throw new Error("installed root entrypoint default export is missing setup() or server()")
}
if (serverModule?.default !== rootDefinition) {
    throw new Error("installed server entrypoint is not the same dual definition as root")
}
const tuiDefinition = tuiModule?.default
if (
    tuiModule?.ACP_TUI_PLUGIN_ID !== "opencode-acp-tui" ||
    !tuiDefinition ||
    tuiDefinition.id !== "opencode-acp-tui" ||
    typeof tuiDefinition.setup !== "function"
) {
    throw new Error("installed TUI entrypoint has the wrong definition shape")
}
const rpc = rpcModule?.AcpRpc
const required = rpc?.events?.notification?.schema?.required
if (
    rpc?.id !== ${JSON.stringify(expectedPackageName)} ||
    !rpc?.events?.notification?.schema ||
    !Array.isArray(required) ||
    !["title", "message", "variant"].every((field) => required.includes(field))
) {
    throw new Error("installed RPC entrypoint has the wrong notification schema")
}

const resolvedRoot = fileURLToPath(import.meta.resolve(${JSON.stringify(pkg.name)}))
const resolvedPackage = path.dirname(path.dirname(resolvedRoot))
const expectedPackage = ${JSON.stringify(packageDir)}
const expectedInstallRoot = ${JSON.stringify(installRoot)}
const relative = path.relative(expectedInstallRoot, resolvedPackage)
if (
    resolvedPackage !== expectedPackage ||
    relative === "" ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
) {
    throw new Error("installed entrypoints resolved outside the isolated opencode-acp package")
}
`

    try {
        writeFileSync(probePath, probeSource, "utf8")
        const probeHome = path.join(installRoot, "probe-home")
        const probeTmp = path.join(installRoot, "probe-tmp")
        mkdirSync(probeHome, { recursive: true })
        mkdirSync(probeTmp, { recursive: true })
        const nodeEnv = buildMinimalProbeEnv({
            home: probeHome,
            tmpdir: probeTmp,
            npm: false,
        })
        assertMinimalProbeEnv(nodeEnv, false)
        execFileSync(process.execPath, [probePath], {
            cwd: installRoot,
            env: nodeEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        })
    } catch (error) {
        const stderr = error?.stderr ? String(error.stderr).trim() : ""
        const stdout = error?.stdout ? String(error.stdout).trim() : ""
        const detail =
            stderr || stdout || (error instanceof Error ? error.message : "unknown error")
        fail(`installed package entrypoint verification failed: ${detail}`)
    } finally {
        rmSync(probePath, { force: true })
    }
}

function installArtifactForVerification(pkg, tarballPath) {
    ensureApprovedStagingParent()
    let installRoot
    let installIdentity
    try {
        installRoot = mkdtempSync(path.join(approvedStagingParent, installPrefix))
        installIdentity = captureOwnedDirectory(installRoot, {
            label: "package install root",
            parent: approvedStagingParent,
            prefix: installPrefix,
        })
        const npmrc = path.join(installRoot, "npmrc")
        const globalNpmrc = path.join(installRoot, "global-npmrc")
        const installHome = path.join(installRoot, "home")
        const installTmp = path.join(installRoot, "tmp")
        const installCache = path.join(installRoot, "npm-cache")
        mkdirSync(installHome, { recursive: true })
        mkdirSync(installTmp, { recursive: true })
        mkdirSync(installCache, { recursive: true })
        // npm 11 treats `npm install --no-save <tarball>` in an entirely empty
        // directory as a no-op. A private probe manifest makes the isolated root a
        // real project without adding the candidate package to persistent metadata.
        writeFileSync(
            path.join(installRoot, "package.json"),
            `${JSON.stringify({
                name: "opencode-acp-package-verification",
                version: "1.0.0",
                private: true,
            })}\n`,
        )
        writeFileSync(
            npmrc,
            "registry=https://registry.npmjs.org/\nfund=false\naudit=false\nupdate-notifier=false\n",
        )
        writeFileSync(globalNpmrc, "")
        const npmEnv = buildMinimalProbeEnv({
            home: installHome,
            tmpdir: installTmp,
            userconfig: npmrc,
            globalconfig: globalNpmrc,
            cache: installCache,
            npm: true,
        })
        assertMinimalProbeEnv(npmEnv, true)
        try {
            execFileSync(
                "npm",
                ["install", "--ignore-scripts", "--no-save", "--package-lock=false", tarballPath],
                {
                    cwd: installRoot,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                    env: npmEnv,
                },
            )
        } catch (error) {
            const stderr = error?.stderr ? String(error.stderr).trim() : ""
            const stdout = error?.stdout ? String(error.stdout).trim() : ""
            const detail =
                stderr || stdout || (error instanceof Error ? error.message : "unknown error")
            fail(`isolated npm install of the real ACP tarball failed: ${detail}`)
        }
        const packageDir = path.join(installRoot, "node_modules", pkg.name)
        if (!existsSync(path.join(packageDir, "package.json"))) {
            fail("isolated npm install did not create node_modules/opencode-acp")
        }
        const packageIdentity = captureOwnedDirectory(packageDir, {
            label: "installed package directory",
            parent: installIdentity.realPath,
            prefix: pkg.name,
        })
        validateInstalledModules(pkg, installIdentity.realPath, packageIdentity.realPath)
    } finally {
        if (installIdentity) {
            removeExactStagingRoot(installIdentity, installPrefix)
        } else if (
            installRoot &&
            path.dirname(installRoot) === approvedStagingParent &&
            path.basename(installRoot).startsWith(installPrefix)
        ) {
            // `mkdtempSync` produced this exact private child, but setup failed
            // before identity capture completed. Remove only that generated path.
            rmSync(installRoot, { recursive: true, force: true })
        }
    }
}

async function main() {
    assertRepoFilesExist()
    const pkg = assertPackageManifestAndLock()
    assertPackageJsonShape(pkg)
    validateSourceRuntimeImportGraph()

    const packed = createPackedArtifact(pkg)
    try {
        validateBuiltRuntimeImportGraph(packed.packedPaths)
        installArtifactForVerification(pkg, packed.tarballPath)
    } finally {
        packed.cleanup()
    }

    console.log(`package verification passed for ${packed.result.name}@${packed.result.version}`)
    console.log(`tarball entries: ${packed.result.entryCount ?? packed.result.files.length}`)
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
