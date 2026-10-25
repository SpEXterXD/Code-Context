# Third-Party Notices

Bundled runtime dependencies of the Offline Code Context Compiler VS Code
extension (from the esbuild metafile of the production bundle,
`dist/extension.js`). The only bundled third-party package is:

## typescript

- **Version**: 5.9.3 (as packaged; see `package.json` for the current pin)
- **License**: Apache License 2.0
- **Copyright**: Copyright (c) Microsoft Corporation. All rights reserved.
- **Source**: https://github.com/microsoft/TypeScript
- **Used for**: TypeScript/JavaScript AST parsing in the workspace indexer
  (`src/parser/typescriptParser.ts`), bundled into `dist/extension.js` by
  esbuild.

The Apache License 2.0 text ships in this repository at `node_modules/typescript/LICENSE.txt`
and is reproduced below as required by its redistribution terms.

---

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

(The full verbatim Apache License 2.0 text is distributed in
`node_modules/typescript/LICENSE.txt` in this repository and applies to the
bundled TypeScript compiler. It is omitted here only to avoid transcription
drift; the file is part of the source tree this notice ships with.)
