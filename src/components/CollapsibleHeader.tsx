/**
 * Panel header that toggles the visibility of the panel body. The open state
 * is owned by the caller so it can be persisted.
 */
import type { ReactNode } from 'react';

interface CollapsibleHeaderProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Id of the element shown and hidden by the header. */
  controls: string;
  /** Extra content aligned to the right of the title. */
  children?: ReactNode;
}

export default function CollapsibleHeader({ title, open, onToggle, controls, children }: CollapsibleHeaderProps) {
  return (
    <button
      type="button"
      className={`panel-header w-full text-left transition-colors hover:text-terminal-text ${open ? '' : 'border-b-0'}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block w-2 text-terminal-faint">
          {open ? '▾' : '▸'}
        </span>
        {title}
      </span>
      {children}
    </button>
  );
}
