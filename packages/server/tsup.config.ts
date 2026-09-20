import { defineConfig } from 'tsup';

/**
 * Two bundles from one source tree:
 *  - index.js  : long-running Node server for local dev and container hosting
 *  - lambda.js : API Gateway handler for the serverless deployment
 *
 * Bundling (rather than emitting a directory of modules) is what lets the
 * Lambda artefact stay a single file with the AWS SDK left external, since the
 * runtime already provides it.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', lambda: 'src/lambda.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  // The AWS SDK is provided by the Lambda runtime, so shipping it would only
  // inflate the artefact and slow cold starts.
  external: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
  /*
   * `@wealth/shared` must be bundled, not externalised.
   *
   * It is a workspace package whose entry point is TypeScript *source* with
   * `.js` import specifiers - the convention TypeScript requires for ESM. Node
   * cannot resolve those at runtime (it looks for `types.js`, which does not
   * exist), so leaving it external produces a build that compiles cleanly and
   * then dies on startup. tsup externalises everything in `dependencies` by
   * default, which is why this has to be stated.
   */
  noExternal: [/^@wealth\//],
});
