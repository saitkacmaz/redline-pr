import { Fragment } from 'react';
import { lineRange, splitPath } from '../paths';

interface Props {
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

/**
 * `src/api/` in faint ink, then `server.js:34–36` in the surrounding ink. The directory may
 * wrap after any slash in a narrow column; the file name and its lines never break.
 */
export function PathLabel({ path, startLine, endLine }: Props) {
  const { dir, name } = splitPath(path);
  const lines = startLine === undefined ? '' : lineRange(startLine, endLine ?? startLine);
  const parts = dir.split('/').slice(0, -1);
  return (
    <>
      {dir && (
        <span className="text-faint">
          {parts.map((part, i) => (
            <Fragment key={i}>
              {part}/<wbr />
            </Fragment>
          ))}
        </span>
      )}
      <span className="whitespace-nowrap">
        {name}
        {lines}
      </span>
    </>
  );
}
