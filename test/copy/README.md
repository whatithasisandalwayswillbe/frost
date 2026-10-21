# Copy expectations

The captures in `test/fixtures/` are immutable. These expectations record the intentional wording changes from the copy review separately, without replacing the original captures, inputs or exit codes.

`cli.json` contains literal copy substitutions, with captures that preserve dynamic values and their formatting. `tui.json` contains reviewed rows at the captured window sizes for Windows and POSIX paths. Each row includes its original content so an unexpected change to a frozen reference fails explicitly. The existing comparisons still check every displayed cell, style and colour profile.

Changes cover the reviewed wording, its wrapping and the resulting placement within the existing layouts. Unchanged rows use the original captures. These files have no update or recording mode in the test suite.

`manifest-compression.fixture` preserves the compiled manifest source used by the ZIP compression sample before the copy changes. The ZIP ratio test uses these fixed bytes so editing an error message does not replace its test input. The compression implementation and ratio threshold are unchanged; the other code samples still use the current source.
