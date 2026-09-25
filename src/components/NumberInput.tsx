import React, { useEffect, useRef, useState } from 'react';

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Allow decimal points (prices, costs). Defaults to integers-only. */
  allowDecimal?: boolean;
  min?: number;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  title?: string;
  className?: string;
  ariaLabel?: string;
  id?: string;
}

/**
 * Numeric entry that behaves like a text field:
 * - type digits directly (no spinner stepping)
 * - rejects leading zeros ("089" becomes "89")
 * - rejects letters and stray characters at the input level
 * - allows decimals when `allowDecimal` is set
 *
 * The value is kept as the raw string while typing so editing works naturally,
 * and is parsed through `onChange` as a number for the parent's state.
 */
export const NumberInput: React.FC<NumberInputProps> = ({
  value,
  onChange,
  allowDecimal = false,
  min = 0,
  placeholder,
  disabled,
  readOnly,
  title,
  className = '',
  ariaLabel,
  id,
}) => {
  const [raw, setRaw] = useState<string>(() => String(value ?? 0));
  const [focused, setFocused] = useState(false);
  const latestValue = useRef(value);
  latestValue.current = value;

  // Sync from the parent when not editing (e.g. after external resets).
  useEffect(() => {
    if (!focused) setRaw(String(value ?? 0));
  }, [value, focused]);

  const sanitize = (input: string): string => {
    let next = input;
    if (!allowDecimal) {
      next = next.replace(/[^0-9]/g, '');
    } else {
      next = next
        .replace(/[^0-9.]/g, '')
        .replace(/(\..*)\./g, '$1'); // only one decimal point
    }
    // Block leading zeros: "0" alone is fine, "089" becomes "89", "00" -> "0".
    next = next.replace(/^0+(?=\d)/, '');
    return next;
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const cleaned = sanitize(event.target.value);
    setRaw(cleaned);
    if (cleaned === '') {
      onChange(min);
      return;
    }
    const parsed = allowDecimal ? parseFloat(cleaned) : parseInt(cleaned, 10);
    if (Number.isFinite(parsed)) onChange(parsed);
  };

  const handleBlur = () => {
    setFocused(false);
    const parsed = parseFloat(raw);
    if (raw === '' || !Number.isFinite(parsed) || parsed < min) {
      setRaw(String(latestValue.current ?? 0));
    } else {
      setRaw(String(parsed));
    }
  };

  const baseClass =
    'rounded border border-primary-mid/30 bg-white text-sm outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-primary-light/30 disabled:text-text-muted';

  return (
    <input
      id={id}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      value={raw}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      title={title}
      aria-label={ariaLabel}
      onChange={handleChange}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation();
      }}
      className={`${baseClass} ${className}`}
    />
  );
};
