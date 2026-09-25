import React, { useEffect, useRef, useState } from 'react';

const CREATE_VALUE = '__create__';

interface ReusableSelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  onCreate: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** Text used in the create option, e.g. "group" -> + New group. */
  entityLabel?: string;
}

/**
 * A native select that can create a new reusable value inline.
 * Choosing "+ New …" reveals a small input; Enter commits and selects it.
 */
export const ReusableSelect: React.FC<ReusableSelectProps> = ({
  value,
  options,
  onChange,
  onCreate,
  placeholder = 'Select…',
  className = '',
  ariaLabel,
  entityLabel = 'value',
}) => {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const commit = () => {
    const name = draft.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    onCreate(name);
    onChange(name);
    setDraft('');
    setCreating(false);
  };

  if (creating) {
    return (
      <span className={`inline-flex items-center gap-1 ${className}`}>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          placeholder={`New ${entityLabel}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft('');
              setCreating(false);
            }
          }}
          className="w-28 min-w-0 rounded border border-primary-mid/50 bg-white px-1.5 py-1 text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
        />
        <button
          type="button"
          onClick={commit}
          className="rounded bg-accent px-1.5 py-1 text-[10px] font-semibold text-white hover:bg-accent-soft"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft('');
            setCreating(false);
          }}
          className="rounded px-1 py-1 text-[10px] text-text-muted hover:text-text-secondary"
        >
          ✕
        </button>
      </span>
    );
  }

  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (next === CREATE_VALUE) {
          setCreating(true);
          return;
        }
        onChange(next);
      }}
      className={`w-full min-w-0 cursor-pointer rounded border border-transparent bg-transparent px-1 py-1 text-xs text-text-primary outline-none hover:border-primary-mid/40 focus:border-accent focus:bg-white focus:ring-1 focus:ring-accent/20 ${className}`}
    >
      <option value="">{placeholder}</option>
      {value && !options.includes(value) && <option value={value}>{value}</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
      <option value={CREATE_VALUE}>+ New {entityLabel}…</option>
    </select>
  );
};
