/* Non-JS modules wrangler bundles: CompiledWasm for .wasm (its default), and
   the Data rule in wrangler.jsonc for fonts and the icon. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
