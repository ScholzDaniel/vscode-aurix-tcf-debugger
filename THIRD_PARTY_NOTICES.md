# Third-Party Notices

The MIT license in [`LICENSE`](LICENSE) covers only the source code written for
this project (everything under `src/`, `scripts/`, `media/`, and the project
configuration files).

It does **not** cover the prebuilt tools shipped under `bin/`. Those tools come
from [AURIX&trade; Configuration Studio](https://www.infineon.com/design-resources/platforms/aurix-software-tools/aurix-tools/aurix-configuration-studio)
and remain subject to their applicable licenses. They are owned by Infineon
Technologies AG and third parties, not by this project. This notice does not
grant redistribution rights.

The proprietary AURIX Flasher and its accompanying files are bundled under
`bin/aurixflasher/` in the source tree and VSIX because the TCF agent invokes
Flasher during startup, including debug-only sessions. The bundle also provides
optional integrated pre-debug ELF and PPU/CDSP HEX flashing.

The accompanying notices are retained under `bin/aurixflasher/license/`.
They do not establish licensing for the debugger, DAS components or SVD files.
Check the applicable terms for the complete bundle before redistribution.
