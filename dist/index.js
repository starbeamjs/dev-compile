import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Package, rootAt } from '@starbeam-dev/core';
import copy from 'rollup-plugin-copy';
import 'typescript';
import { createRequire } from 'node:module';
import { getTsconfig } from 'get-tsconfig';

// originally from: https://github.com/vitejs/vite/blob/51e9c83458e30e3ce70abead14e02a7b353322d9/src/node/build/buildPluginReplace.ts
const { default: MagicString } = await import('magic-string');
/** @typedef {import("rollup").TransformResult} TransformResult */ /** @typedef {import("rollup").Plugin} RollupPlugin */ /**
 * Replace literal strings in code with specified replacements with sourcemap
 * support.
 *
 * Example rollup config:
 *
 * ```js
 * import { replace } from "@starbeam-dev/compile";
 *
 * export default {
 *   // ...
 *   plugins: [
 *     replace({ "import.meta.hello": `"world"` })
 *   ]
 * };
 * ```
 *
 * This will replace any instances of `import.meta.hello` in source modules with
 * the content `"world"`.
 *
 * The main purpose of this plugin is to replace dynamic variables with
 * build-time constant values, which can then be further processed by a
 * minification pass.
 *
 * For example, the `importMeta` plugin replaces `import.meta.env.DEV` with
 * `true` in development mode and `false` in production mode. In production,
 * source code guarded with `if (import.meta.env.DEV)` will be emitted as `if
 * (false)`. The subsequent minification pass will remove the entire `if` block,
 * including its contents.
 *
 * @param {(id: string) => boolean} test
 * @param {Record<string, string>} replacements @param {boolean} sourcemap
 *
 * @returns {RollupPlugin}
 */ function createReplacePlugin(test, replacements, sourcemap) {
    const pattern = new RegExp("\\b(" + Object.keys(replacements).map((str)=>{
        return str.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
    }).join("|") + ")\\b", "g");
    return {
        name: "starbeam:replace",
        transform (code, id) {
            if (test(id)) {
                const s = new MagicString(code);
                let hasReplaced = false;
                let match;
                while(match = pattern.exec(code)){
                    hasReplaced = true;
                    const start = match.index;
                    const [wholeMatch, partialMatch] = match;
                    const end = start + wholeMatch.length;
                    const replacement = replacements[partialMatch];
                    if (replacement === undefined) {
                        throw new Error(`Unexpected missing replacement for "${partialMatch}".\n\nReplacements were ${JSON.stringify(replacements, null, STRINGIFY_SPACES)}`);
                    }
                    s.overwrite(start, end, replacement);
                }
                if (!hasReplaced) {
                    return null;
                }
                /** @type {TransformResult} */ const result = {
                    code: s.toString()
                };
                if (sourcemap) {
                    result.map = s.generateMap({
                        hires: true
                    });
                }
                return result;
            }
        }
    };
}
const STRINGIFY_SPACES = 2;

/**
 * Replaces `import.meta` environment annotations with constants depending on
 * the specified mode.
 *
 * If no mode is specified, the mode defaults to `process.env["MODE"]`. If
 * `process.env["MODE"]` is not set, the mode defaults to `"development"`.
 *
 * If you want to control this plugin without relying on ambient environment
 * variables, you should specify the mode explicitly.
 *
 * Replacements:
 *
 * | source                 | replacement rule                                 |
 * | ---------------------- | ------------------------------------------------ |
 * | `import.meta.env.MODE` | the specified mode (string)                      |
 * | `import.meta.env.DEV`  | true if the mode is "development" (boolean)      |
 * | `import.meta.env.PROD` | true if the mode is "production" (boolean)       |
 *
 * It is possible for both `DEV` and `PROD` to be false (if the specified mode
 * is something other than `"development"` or `"production"`). In general, this
 * is not recommended when using this plugin.
 */ var importMeta = ((mode = process.env["MODE"] ?? "development")=>{
    const DEV = mode === "development";
    const PROD = mode === "production";
    const STARBEAM_TRACE = process.env["STARBEAM_TRACE"] ?? false;
    return createReplacePlugin((id)=>/\.(j|t)sx?$/.test(id), {
        // remove inline testing
        "import.meta.vitest": "false",
        // env
        "import.meta.env.MODE": mode,
        "import.meta.env.DEV": DEV ? "true" : "false",
        "import.meta.env.PROD": PROD ? "true" : "false",
        "import.meta.env.STARBEAM_TRACE": STARBEAM_TRACE ? "true" : "false"
    }, true);
});

const INLINE_PREFIX = "\0inline:";
/**
 * Inlines any imports that end in `?inline` into the importing module as a
 * string.
 *
 * This adds Vite's `?inline` feature to standalone rollup builds.
 */ var inline = (()=>{
    return {
        name: "inline",
        async resolveId (source, importer, options) {
            const path = removeTrailing(source, "?inline");
            if (path) {
                const resolved = await this.resolve(path, importer, options);
                if (resolved && !resolved.external) {
                    await this.load(resolved);
                    return INLINE_PREFIX + resolved.id;
                }
            }
        },
        async load (id) {
            if (id.startsWith(INLINE_PREFIX)) {
                const path = id.slice(INLINE_PREFIX.length);
                const code = readFileSync(path, "utf8");
                return Promise.resolve({
                    code: `export default ${JSON.stringify(code)};`
                });
            }
        }
    };
});
const FIRST_CHAR = 0;
function removeTrailing(source, trailing) {
    if (source.endsWith(trailing)) {
        return source.slice(FIRST_CHAR, -trailing.length);
    }
}

/**
 * The package should be inlined into the output. In this situation, the `external` function should
 * return `false`. This is the default behavior.
 */ const INLINE = false;
/**
 * The package should be treated as an external dependency. In this situation, the `external` function
 * should return `true`. This is unusual and should be used when:
 *
 * - The package is a "helper library" (such as tslib) that we don't want to make a real dependency
 *   of the published package.
 * - (for now) The package doesn't have good support for ESM (i.e. `type: module` in package.json)
 *   but rollup will handle it for us.
 */ const EXTERNAL = true;

/**
 * @typedef {import("#core").PackageInfo} PackageInfo
 */ /**
 * A plugin that applies the default starbeam-dev externals rules to the builds
 * for the specified package.
 *
 * When an import is "external", it is left as-is in the built package. When an
 * import is "inline", it is combined with the built package's main file and
 * further optimized.
 *
 * In general, it's better to inline an import if any of the following are true:
 *
 * 1. It is only used by this package.
 * 2. Its exports are easy to optimize by a minifier in production builds (e.g.
 *    exports that are simple functions that have no behavior or simply return
 *    its argument). Functions that use `import.meta.env.DEV` guards around
 *    behavior that would be tricky to optimize are still good candidates for
 *    inlining.
 * 3. More generally, when inlining the import in production mode is likely to
 *    save more bytes than the bytes lost due to duplication.
 *
 * ## Rules
 *
 * 1. Relative imports: If the import starts with a `.`, then it is an inline
 *    import.
 * 2. Custom rules: If the `starbeam:inline` key in `package.json` specifies a
 *    rule for a dependency, use it. You can use custom rules to override any of
 *    the default rules below.
 * 3. [TODO] Custom workspace rules: If the `starbeam:inline` key in the
 *    `package.json` for the workspace root specifies a rule for a dependency,
 *    use it.
 * 4. Helper libraries: If the import is one of the well-known helper libraries,
 *    then it is an inline import.
 * 5. Absolute imports: If the import starts with `/`, then it is an inline
 *    import. This is because absolute imports are usually relative imports
 *    previously resolved by the build process. In general, you should not use
 *    absolute imports in your source code when using this plugin (and probably
 *    in general).
 * 6. Import map imports: If the import starts with `#`, then it is an inline
 *    import. Since import-map imports typically resolve to relative imports,
 *    the current behavior is to inline them.
 * 7. If the `starbeam:external` key in `package.json` specifies a rule for a
 *    dependency, use it.
 *
 * It would probably be more correct to attempt to resolve import map imports
 * and then apply the rules above to the resolved imports. Please file an issue
 * describing your situation if you need this.
 *
 * ## Well-Known Helper Libraries
 *
 * - `@babel/runtime/*`
 * - `tslib`
 * - `@swc/core`
 *
 * ## Manifest Rules (`starbeam:external` keys)
 *
 * The `starbeam:inline` key is either an array of rules or a rules object.
 *
 * ### Rule Pattern
 *
 * A rule pattern is a string, one of the following:
 *
 * - The name of a package listed in the `dependencies` or
 *   `optionalDependencies` field  of the `package.json` file
 * - A pattern that ends in a `*` (e.g. `@starbeam/*`) and matches the name of
 *   at least one package listed in the `dependencies` or
 *   `optionalDependencies`. The `*` matches one or more characters that are
 *   valid as part of an npm package name.
 * - The special pattern `(helpers)`. This matches all of the well-known helper
 *   libraries.
 *
 * ### Rules Array
 *
 * The easiest way to specify inlining rules is by specifying an array of
 * patterns.
 *
 * Example:
 *
 * ```json
 * {
 *   "dependencies": {
 *     "react": "^18.2.0",
 *     "lodash": "^4.17.21"
 *   },
 *
 *   "starbeam:inline": ["lodash"]
 * }
 * ```
 *
 * Any patterns in the array will be configured to be inlined. These patterns
 * supersede the default behavior.
 *
 * ### Rules Object
 *
 * Each key in the object is a rule pattern, and the value is either "inline" or
 * "external".
 *
 * Example:
 *
 * ```json
 * {
 *   "dependencies": {
 *     "react": "^18.2.0",
 *     "lodash": "^4.17.21"
 *   },
 *
 *   "starbeam:inline": {
 *     "loadash": "inline"
 *   }
 * }
 * ```
 *
 * In this example, the `react` dependency is externalized, and the `lodash`
 * dependency is inlined.
 *
 * The default behavior is to externalize all dependencies, so you don't need to
 * specify "external" in a rules object unless you want to supersede a later
 * rule.
 *
 * Example:
 *
 * ```json
 * {
 *   "dependencies": {
 *     "react": "^18.2.0",
 *     "lodash.map": "^4.17.21",
 *     "lodash.merge": "^4.17.21"
 *     "lodash.flat-map": "^4.17.21"
 *   },
 *
 *   "starbeam:inline": {
 *     "lodash.merge": "external",
 *     "lodash.*": "inline"
 *   }
 * }
 * ```
 *
 * In this example, `react` and `lodash.merge` are externalized, and
 * `lodash.map` and `lodash.flat-map` are inlined.
 *
 * ### Rule Objects in a Rules Array
 *
 * When you have a lot of inline rules and only a handful of externals
 * overrides, it's nice to be able to avoid repeating `: "inline"` over and over
 * again.
 *
 * In this situation, you can include rule objects in a rules array.
 *
 * Example:
 *
 * Instead of this:
 *
 * ```json
 * "starbeam:inline": {
 *   "lodash.merge": "external",
 *   "lodash.*": "inline"
 * }
 * ```
 *
 * You can do this:
 *
 * ```json
 * "starbeam:inline": [
 *   { "lodash.merge": "external" },
 *   "lodash.*"
 * ]
 * ```
 *
 * ## Matching Order for Custom Rules
 *
 * Custom rules are matched in the order they are listed in the
 * `starbeam:external` key.
 *
 * Earlier rules in the rule array take precedence over later rules. Earlier
 * rules in an rules object take precedence over later rules in the same rule
 * object.
 *
 * ## Development and Peer Dependencies
 *
 * Since development dependencies are not intended to be used at runtime, they
 * should never be imported from runtime code, and therefore should never be
 * included in the build.
 *
 * Since peer dependencies are intended to be supplied by a dependent package
 * (i.e. the package including the package you are building), they are always
 * external and should not be listed in the `starbeam:external` key.
 *
 * @param {PackageInfo} pkg
 * @returns {import("rollup").Plugin}
 */ function externals(pkg) {
    const isExternal = external(pkg);
    return {
        name: "starbeam:externals",
        resolveId (id) {
            if (isExternal(id)) {
                return {
                    id,
                    external: true
                };
            }
        }
    };
}
/**
 * @param {PackageInfo} pkg
 * @returns
 */ function external(pkg) {
    /**
   * @param {string} id
   * @returns {boolean}
   */ return (id)=>{
        // Inline relative modules.
        if (id.startsWith(".")) {
            return INLINE;
        }
        // Resolve custom rules. These rules include the default behavior of
        // well-known helper libraries.
        for (const rule of pkg.starbeam.inline){
            const isExternal = resolveIsExternal(rule, id);
            if (isExternal !== undefined) return isExternal;
        }
        // Allow custom rules to override the default behavior
        // of `#` and `/` dependencies.
        if (id.startsWith("#") || id.startsWith("/")) {
            return INLINE;
        }
        const strictExternals = pkg.starbeam.strict.externals;
        if (strictExternals !== "allow") {
            const message = [
                `The external dependency ${id} is included in your compiled output. This means that your compiled output will contain a runtime import of that package.`,
                `This is the default behavior of starbeam-dev, but you did not specify an inline rule for ${id}, and there is no built-in rule that applies to ${id}.`
            ];
            if (strictExternals === "error") {
                const error = [
                    `Unexpected external dependency: ${id}.`,
                    ...message,
                    `This is an error because you are in strict externals mode (${strictExternals}), as specified in "starbeam:strict" in your package.json at:\n  ${join(pkg.root, "package.json")})`
                ].join("\n\n");
                throw Error(error);
            } else {
                console.warn([
                    ...message,
                    `This message appears because you are in strict externals mode (${strictExternals}), as specified in "starbeam:strict" in your package.json at:\n  ${join(pkg.root, "package.json")})`
                ].join("\n"));
            }
        }
        return true;
    };
}
function resolveIsExternal(option, id) {
    return findExternalFn(option)(id);
    /**
   * @param {import("#core").NormalizedExternalOption} option
   * @returns {(id: string) => import("#core").RollupExternal | undefined}
   */ function findExternalFn([operator, name, config]) {
        const find = operatorFn(operator);
        return (id)=>find(id, name) ? fromConfig(config) : undefined;
    }
    /**
   * @param {import("#core").ExternalConfig | undefined} config
   * @returns {import("#core").RollupExternal | undefined}
   */ function fromConfig(config) {
        switch(config){
            case "external":
                return EXTERNAL;
            case "inline":
                return INLINE;
            case undefined:
                return undefined;
        }
    }
    function operatorFn(operator) {
        switch(operator){
            case "startsWith":
                return (id, key)=>id.startsWith(key);
            case "is":
                return (id, key)=>id === key;
        }
    }
}

const require = createRequire(import.meta.url);
const rollupTS = require("rollup-plugin-ts");
/**
 * Build a library with TypeScript in the specified mode.
 *
 * This plugin uses swc (via `@swc/core`) to efficiently compile TypeScript to
 * JavaScript.
 *
 * ## Assumptions
 *
 * You are using at least TypeScript 5.0.
 *
 * You are using the (large) subset of TypeScript that can be compiled by
 * evaluating a single module and stripping out type-specific features. You are
 * not using features of TypeScript that require multi-module analysis to
 * determine how to compile a single module.
 *
 * - You should not use `const` enums, but if you do, they will be converted
 *   into normal enums.
 * - All import paths that refer to non-existent JavaScript modules (type-only
 *   modules) are imported using `import type`.
 * - All imports that do not refer to a JavaScript value are imported as part of
 *   an `import type` statement or are annotated with `type` (i.e. `import {
 *   map, type MapFn } from "map"`).
 *
 * ## Recommendations
 *
 * To ensure that your code satisfies these assumptions, we recommend the
 * following tsconfig options:
 *
 * <dl>
 *   <dt>`verbatimModuleSyntax`: true</dt>
 *   <dd>
 *     You will get a TypeScript error if one of your imports is only
 *     used as a type but does not include the `type` specifier.
 *   </dd>
 * </dl>
 *
 * We also recommend the use of `@typescript-eslint/consistent-type-imports` and
 * `@typescript-eslint/no-import-type-side-effects`. These auto-fixable lints
 * will error if you don't use `import type` on an import statement that is
 * never used as a value. These lints will also ensure that any named imports
 * that are only used as types are annotated with `type`.
 *
 * If you're using vscode, you can enable "source.fixAll" in
 * `editor.codeActionOnSave` and imports will automatically be updated if you
 * need to add or remove `import type`.
 *
 * ## Type Checking
 *
 * > **TL;DR** This plugin does **not** typecheck your code. It is intended to
 * > be run after verifying your code using tools such as `tsc` and `eslint` and
 * > after successfully running your tests.
 *
 * Now for the longer version...
 *
 * **Compiling** a library is a separate step from **verifying** the library.
 *
 * Conversationally, people refer to the process of verifying and compiling a
 * library as "the build" (i.e. "failing the build").
 *
 * This is largely an artifact of workflows in other languages, such as Java,
 * C++ and Rust. In these languages, the *compiler* performs a large amount of
 * verification before compilation can begin.
 *
 * Even in those environments, many projects perform additional verification
 * steps (such as linting and testing) before creating and publishing the
 * compilation artifacts.
 *
 * But in **our** environment, virtually the entire verification step can be
 * performed before the compilation step.
 *
 * > Adding to the confusion, the tool that you use to *verify* your TypeScript
 * > code is called `tsc`. Even more confusingly, `tsc` is intended to be a
 * > good-enough reference compiler for TypeScript code. In practice, though, it
 * > makes more sense to use `tsc` as part of a comprehensive *verification*
 * > strategy and to use other tools (such as `esbuild` or `swc`) to compile
 * > your TypeScript code.
 *
 * ## Verify Separately
 *
 * This plugin is intended to be used as part of a build process that runs the
 * verification step first, and only invokes the compilation step once the
 * verification step has completed.
 *
 * These same verification steps should run in your CI pipeline.
 *
 * During development, we recommend that you use the same verification tools in
 * your editor, which can help developers avoid submitting pull requests that
 * will fail verification.
 */ function typescript(mode) {
    return (pkg, config)=>{
        const { config: tsconfig } = getTsconfig(pkg.root) ?? {};
        const compilerOptions = tsconfig?.compilerOptions ?? {};
        const transform = {
            treatConstEnumAsEnum: true
        };
        const minify = {
            mangle: {
                // module: true,
                toplevel: true,
                properties: {
                    builtins: false
                }
            },
            module: true,
            compress: {
                module: true,
                passes: 4,
                unsafe_math: true,
                unsafe_symbols: mode === "production",
                hoist_funs: true,
                conditionals: true,
                drop_debugger: true,
                evaluate: true,
                reduce_vars: true,
                side_effects: true,
                dead_code: true,
                defaults: true,
                unused: true
            }
        };
        let jscConfig = {
            transform
        };
        if (mode === "production") {
            jscConfig.minify = minify;
        }
        const fragmentFactory = compilerOptions.jsxFragmentFactory;
        const jsxFactory = compilerOptions.jsxFactory;
        if (fragmentFactory && jsxFactory) jscConfig = withReact(jscConfig, {
            pragma: jsxFactory,
            pragmaFrag: fragmentFactory
        });
        const importSource = compilerOptions.jsxImportSource;
        if (importSource) jscConfig = withReact(jscConfig, {
            runtime: "automatic",
            importSource
        });
        return rollupTS({
            transpiler: "swc",
            transpileOnly: true,
            swcConfig: {
                jsc: jscConfig
            },
            tsconfig: {
                ...compilerOptions,
                ...config
            }
        });
    };
}
function withReact(jsc, react) {
    jsc.transform ??= {};
    jsc.transform.react = {
        ...jsc.transform.react,
        ...react
    };
    return jsc;
}

const MODES = [
    "development",
    "production",
    undefined
];
function compile(here, options) {
    const pkg = Package.at(here);
    if (pkg === undefined) {
        throw new Error(`Package not found at ${rootAt(here)}`);
    }
    return compilePackage(pkg, options || {});
}
function copyRootChangelog(pkg) {
    const monorepoRoot = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        cwd: pkg.root
    }).trim();
    const rootChangelog = join(monorepoRoot, 'CHANGELOG.md');
    // this plugin does not provide types
    const includeChangelog = copy({
        targets: [
            {
                src: rootChangelog,
                dest: '.'
            }
        ]
    });
    return includeChangelog;
}
/**
 * @param {import("@starbeam-dev/core").PackageInfo} pkg
 * @param {CompileOptions} options
 * @returns {import("rollup").RollupOptions[]}
 */ function compilePackage(pkg, options) {
    return MODES.flatMap((mode)=>{
        const PLUGINS = [];
        if (mode) {
            PLUGINS.push(importMeta(mode));
        }
        const deps = Object.keys(pkg.dependencies);
        const entries = entryPoints(pkg, mode).map((options)=>({
                ...options,
                external: deps,
                plugins: [
                    ...PLUGINS,
                    externals(pkg),
                    typescript(mode)(pkg, {
                        target: "esnext",
                        module: "esnext",
                        moduleDetection: "force",
                        moduleResolution: "bundler",
                        verbatimModuleSyntax: true
                    })
                ]
            }));
        /**
      * We only need to do this once, so we'll push it on the first entrypoint's rollup config
      */ if (options.copyRootChangelog ?? true) {
            const copyPlugin = copyRootChangelog(pkg);
            // eslint-disable-next-line @typescript-eslint/no-magic-numbers
            entries[0]?.plugins.push(copyPlugin);
        }
        return entries;
    });
}
function entryPoints(pkg, mode) {
    const { root, starbeam: { entry } } = pkg;
    function entryPoint([exportName, ts]) {
        return {
            input: resolve(root, ts),
            treeshake: true,
            output: {
                file: filename({
                    root,
                    name: exportName,
                    mode,
                    ext: "js"
                }),
                format: "esm",
                sourcemap: true,
                hoistTransitiveImports: false,
                exports: "auto"
            },
            onwarn: (warning, warn)=>{
                switch(warning.code){
                    case "CIRCULAR_DEPENDENCY":
                    case "EMPTY_BUNDLE":
                        return;
                    default:
                        warn(warning);
                }
            }
        };
    }
    if (entry === undefined) {
        // eslint-disable-next-line no-console
        console.warn("No entry point found for package", pkg.name);
        return [];
    } else {
        return Object.entries(entry).map(entryPoint);
    }
}
function filename({ root, name, mode, ext }) {
    if (mode) {
        return resolve(root, "dist", `${name}.${mode}.${ext}`);
    } else {
        return resolve(root, "dist", `${name}.${ext}`);
    }
}

export { compile, importMeta, inline };
//# sourceMappingURL=index.js.map
