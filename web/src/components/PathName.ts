import { createContext, useContext } from 'react';

/** How the page names a file: its shortest unique tail in this PR (see `shortPaths`). */
export const PathName = createContext<(path: string) => string>((path) => path);

export const usePathName = (): ((path: string) => string) => useContext(PathName);
