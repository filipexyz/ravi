// Entry of the theme-live script (`bun run pages:runtime:build`): what a file
// of a private route gets when it has a live Library theme and no tags,
// instead of the whole runtime. It only keeps `#ravi-theme` current (see
// `liveTheme` in theme.ts).

import { liveTheme } from "./theme";

liveTheme(window);
