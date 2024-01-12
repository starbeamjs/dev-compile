import { RollupOptions } from "rollup";
import { Plugin as RollupPlugin } from "rollup";
declare const _default: (mode?: string) => RollupPlugin;
declare const _default: () => RollupPlugin;
interface CompileOptions {
    /**
     * Copy the changelog from the root of the monorepo.
     * true by default
     */
    copyRootChangelog?: boolean;
}
declare function compile(here: ImportMeta | string, options?: CompileOptions): RollupOptions[];
export { _default as importMeta, _default as inline, compile };
