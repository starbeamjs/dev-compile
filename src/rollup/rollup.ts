import { resolve } from "node:path";

import { Package, type PackageInfo, rootAt } from "@starbeam-dev/core";
import type { RollupOptions } from "rollup";

import externals from "./plugins/external.js";
import importMeta from "./plugins/import-meta.js";
import typescript from "./plugins/typescript.js";
import type { RollupPlugin } from "./utils.js";

const MODES = ["development", "production", undefined] as const;

export function compile(here: ImportMeta | string): RollupOptions[] {
  const pkg = Package.at(here);

  if (pkg === undefined) {
    throw new Error(`Package not found at ${rootAt(here)}`);
  }

  return compilePackage(pkg);
}

/**
 * @param {import("@starbeam-dev/core").PackageInfo} pkg
 * @returns {import("rollup").RollupOptions[]}
 */
function compilePackage(pkg: PackageInfo): RollupOptions[] {
  return MODES.flatMap((mode) => {
    const PLUGINS: RollupPlugin[] = [];

    if (mode) {
      PLUGINS.push(importMeta(mode));
    }

    return entryPoints(pkg, mode).map((options) => ({
      ...options,
      plugins: [
        ...PLUGINS,
        externals(pkg),
        typescript(mode)(pkg, {
          target: "es2022",
          module: "esnext",
          moduleDetection: "force",
          moduleResolution: "bundler",
          verbatimModuleSyntax: true,
        }),
      ],
    }));
  });
}

function entryPoints(
  pkg: PackageInfo,
  mode: "development" | "production" | undefined,
): import("rollup").RollupOptions[] {
  const {
    root,
    starbeam: { entry },
  } = pkg;

  function entryPoint([exportName, ts]: [string, string]): RollupOptions {
    return {
      input: resolve(root, ts),
      output: {
        file: filename({ root, name: exportName, mode, ext: "js" }),
        format: "esm",
        sourcemap: true,
        exports: "auto",
      },
      onwarn: (warning, warn) => {
        switch (warning.code) {
          case "CIRCULAR_DEPENDENCY":
          case "EMPTY_BUNDLE":
            return;
          default:
            warn(warning);
        }
      },
    };
  }

  return Object.entries(entry).map(entryPoint);
}

/**
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.name
 * @param {"development" | "production" | undefined} options.mode
 * @param {"js" | "cjs"} options.ext
 * @returns {string}
 */
function filename({
  root,
  name,
  mode,
  ext,
}: {
  root: string;
  name: string;
  mode: "development" | "production" | undefined;
  ext: "js" | "cjs";
}): string {
  if (mode) {
    return resolve(root, "dist", `${name}.${mode}.${ext}`);
  } else {
    return resolve(root, "dist", `${name}.${ext}`);
  }
}
