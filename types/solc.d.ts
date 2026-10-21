/**
 * solc ships no types of its own and `@types/solc` is not on the registry
 * any more, so the two scripts that drive the compiler declare the slice of
 * the API they use.
 */
declare module "solc" {
  export interface SolcCompiler {
    version(): string;
    compile(input: string): string;
  }
  const solc: SolcCompiler;
  export default solc;
}
