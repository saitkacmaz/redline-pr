import { useEffect, useState } from 'react';
import type { Activity } from '../../../shared/types';

/**
 * A 2px line on the bottom edge of a bar: a slow glide while something is really
 * running, then a brief solid line (ink when done, red on error) that fades away.
 */
export function Hairline({ activity }: { activity: Activity | null }) {
  const [faded, setFaded] = useState(false);
  const settled = activity !== null && activity.state !== 'running';

  useEffect(() => {
    setFaded(false);
    if (!settled) return;
    const t = setTimeout(() => setFaded(true), activity?.state === 'error' ? 4000 : 1400);
    return () => clearTimeout(t);
  }, [activity?.id, activity?.state, settled]);

  if (!activity) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px h-[2px] overflow-hidden">
      {activity.state === 'running' ? (
        <div className="redline-glide h-full w-1/4 bg-ink" />
      ) : (
        <div
          className={`h-full w-full transition-opacity duration-700 ${activity.state === 'error' ? 'bg-del' : 'bg-ink'} ${faded ? 'opacity-0' : 'opacity-100'}`}
        />
      )}
    </div>
  );
}
