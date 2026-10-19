# Third-Party Notices

The MIT license in [`LICENSE`](LICENSE) covers only the source code written for
this project (everything under `src/`, `scripts/`, `media/`, and the project
configuration files).

It does **not** cover the prebuilt tools shipped under `bin/`. Those tools come
from [AURIX&trade; Configuration Studio](https://www.infineon.com/design-resources/platforms/aurix-software-tools/aurix-tools/aurix-configuration-studio)
and remain subject to their applicable licenses. They are owned by Infineon
Technologies AG and third parties, not by this project. This notice does not
grant redistribution rights.

The previously bundled proprietary AURIX Flasher and its accompanying files
have been removed from the current source tree and excluded from VSIX packaging.
The former Flasher license directory did not establish licensing for the
remaining debugger, DAS components or SVD files.

A replacement flasher with Windows/Linux support is planned but not yet
integrated. Its complete dependency and license requirements must be checked
before distribution. Removing the old bundle from the current tree does not
remove copies in earlier Git history or previously published releases.
